"""FastAPI application factory."""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import __version__, licensing
from .config import Config
from .abuse import AbuseMonitor
from .alerts import Alerts, RateLimiter
from .audit import get_settings
from .db import Database
from .deps import Context
from .hub import Hub, Scheduler
from .maintenance import Maintainer
from .packer import Packer
from .routes import ai, appops, auth, cards, devices, pack, reseller, scripts, system, tasks, users

log = logging.getLogger("xscript.server")

SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    # antd injects <style> at runtime (CSS-in-JS), hence 'unsafe-inline' for styles only.
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; "
                               "script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; "
                               "form-action 'self'",
}


def load_signing_key(config: Config):
    """The 卡密 signing key. Created on first start; every packed app embeds its public half."""
    path = config.key_path
    if not path.is_file():
        log.warning("creating a new 卡密 signing key at %s; back it up", path)
        licensing.write_private(licensing.generate_private(), path)
    return licensing.load_private(path)


def create_app(config: Config, start_workers: bool = True) -> FastAPI:
    config.ensure_dirs()
    db = Database(config.db_path)
    db.create_all()
    key = load_signing_key(config)
    alerts = Alerts(db)
    hub = Hub(db, alerts)
    hub.flush_interval = config.status_flush_interval
    abuse_monitor = AbuseMonitor()
    with db.session() as s:
        abuse_monitor.load(s)  # the 24 h abuse windows survive a restart
        boot = get_settings(s)
        hub.offline_minutes = float(boot.get("alert_offline_minutes") or 0)
        hub.log_days = float(boot.get("device_log_days") or 0)
    ctx = Context(config=config, db=db, hub=hub, scheduler=Scheduler(hub, db, config.scheduler_interval),
                  packer=Packer(config, db, alerts), key=key, pubkey=licensing.public_b64(key), alerts=alerts, abuse=abuse_monitor,
                  maint=Maintainer(config, db, hub, alerts, config.maintenance_interval),
                  # 热更新 checks every 30 min per device, so 120/min per IP leaves room for NAT'd farms.
                  pub_limiter=RateLimiter(120, 60), apk_limiter=RateLimiter(20, 600),
                  ai_limiter=RateLimiter(20, 600))

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        workers = []
        if start_workers:
            ctx.packer.recover()
            workers = [asyncio.create_task(ctx.scheduler.loop()), asyncio.create_task(ctx.packer.run()),
                       asyncio.create_task(ctx.maint.loop()), asyncio.create_task(hub.flush_loop())]
        yield
        for w in workers:
            w.cancel()
        try:  # batched device status / data; disconnects below write their rows again
            await hub.flush()
        except Exception:  # pragma: no cover
            log.exception("flushing device status on shutdown")
        for conn in list(hub.conns.values()):
            await conn.close()
        db.engine.dispose()

    app = FastAPI(title="XScript 管理后台", version=__version__, lifespan=lifespan,
                  docs_url="/api/docs", redoc_url=None, openapi_url="/api/openapi.json")
    app.state.ctx = ctx

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        for k, v in SECURITY_HEADERS.items():
            response.headers.setdefault(k, v)
        if request.url.path.startswith("/api/"):
            response.headers.setdefault("Cache-Control", "no-store")
        return response

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, exc: StarletteHTTPException):
        # {"error": ...} keeps the /license/* replies compatible with LicenseManager.kt.
        return JSONResponse({"error": exc.detail}, status_code=exc.status_code, headers=getattr(exc, "headers", None))

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError):
        errors = exc.errors()
        first = errors[0] if errors else {}
        where = ".".join(str(x) for x in first.get("loc", [])[1:])
        msg = str(first.get("msg", "invalid request")).removeprefix("Value error, ")
        return JSONResponse({"error": ("%s: %s" % (where, msg)) if where else msg}, status_code=422)

    @app.get("/api/health", tags=["system"])
    def health():
        return {"ok": True, "version": __version__, "online": len(hub.conns)}

    for r in (appops.router, appops.update_router, appops.public, auth.router, users.router, devices.router, tasks.router, cards.router, cards.public, pack.router,
              pack.public, scripts.router, scripts.public, system.router,
              reseller.router, reseller.me, ai.router):
        app.include_router(r)
    app.include_router(devices.ws_router)

    async def _deploy(script_id, target, version_id, run, params):
        try:
            return await scripts.deploy_script(ctx, script_id, target, version_id, run, params)
        except scripts.DeployError as e:
            raise RuntimeError(str(e)) from None

    ctx.scheduler.deploy = _deploy

    _mount_web(app, config.web_dir)
    return app


def _mount_web(app: FastAPI, web_dir: Path | None) -> None:
    """Serve the built React console (backend/web/dist) with SPA fallback to index.html."""
    root = web_dir.resolve() if web_dir else None
    index = root / "index.html" if root else None

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        if path.startswith(("api/", "license/", "pub/")) or path in ("api", "ws", "pub"):
            raise HTTPException(404, "not found")
        if root is None or not index or not index.is_file():
            return JSONResponse({"error": "web console not built; run `npm ci && npm run build` in backend/web"},
                                status_code=503)
        if path:
            f = (root / path).resolve()
            if root in f.parents and f.is_file():
                # Vite puts content hashes in asset names, so they can be cached forever.
                cache = "public, max-age=31536000, immutable" if path.startswith("assets/") else "no-cache"
                return FileResponse(f, headers={"Cache-Control": cache})
        return FileResponse(index, headers={"Cache-Control": "no-cache"})
