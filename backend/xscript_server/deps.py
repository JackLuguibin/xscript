"""Request context, authentication and role checks shared by the API routers."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Callable, Iterator

from fastapi import Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from .audit import audit
from . import netcheck
from .models import AuthToken, Setting, User
from .security import ROLES, LoginLimiter, token_hash

if TYPE_CHECKING:
    from .config import Config
    from .db import Database
    from .hub import Hub, Scheduler
    from .packer import Packer

SESSION_COOKIE = "xs_session"
# Cookie-authenticated writes must carry this header. Browsers cannot add custom headers to
# cross-site requests without a CORS preflight, which this server never grants.
CSRF_HEADER = "x-xscript-csrf"
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
TOTP_EXEMPT = ("/api/auth/", "/api/settings")


@dataclass
class Context:
    config: "Config"
    db: "Database"
    hub: "Hub"
    scheduler: "Scheduler"
    packer: "Packer"
    key: Any  # 卡密 signing key (EC P-256)
    pubkey: str
    alerts: Any = None
    abuse: Any = None
    maint: Any = None
    limiter: LoginLimiter = field(default_factory=LoginLimiter)
    # Public endpoints (/pub/*): 热更新 checks, bundles, share pages and APKs, per client IP.
    pub_limiter: Any = None
    apk_limiter: Any = None


@dataclass
class Principal:
    id: int
    username: str
    role: str
    via: str  # web | api
    token_id: int

    def at_least(self, role: str) -> bool:
        return ROLES.get(self.role, -1) >= ROLES[role]


def ctx(request: Request) -> Context:
    return request.app.state.ctx


def db_session(request: Request) -> Iterator[Session]:
    with ctx(request).db.session() as s:
        yield s


def client_ip(request: Request) -> str:
    return request.client.host if request.client else ""


def ip_allowed(s: Session, ip: str) -> bool:
    """登录 IP 白名单 (system setting); an empty list lets everyone in."""
    row = s.get(Setting, "login_ip_allowlist")
    return netcheck.allowed(ip, row.value if row is not None else [])


def _credentials(request: Request) -> tuple[str, str]:
    auth = request.headers.get("authorization", "")
    if auth[:7].lower() == "bearer ":
        return auth[7:].strip(), "api"
    return request.cookies.get(SESSION_COOKIE, ""), "web"


def current_user(request: Request) -> Principal:
    cached = getattr(request.state, "principal", None)
    if cached is not None:
        return cached
    token, via = _credentials(request)
    if not token:
        raise HTTPException(401, "未登录")
    if via == "web" and request.method not in SAFE_METHODS and request.headers.get(CSRF_HEADER) != "1":
        raise HTTPException(403, "缺少 CSRF 请求头")
    c = ctx(request)
    now = int(time.time())
    with c.db.session() as s:
        if not ip_allowed(s, client_ip(request)):
            raise HTTPException(403, "当前 IP 不在登录白名单内")
        row = s.scalar(select(AuthToken).where(AuthToken.token_hash == token_hash(token)))
        if row is None or row.kind != via or (row.expires_at and row.expires_at <= now):
            raise HTTPException(401, "登录已失效")
        user = s.get(User, row.user_id)
        if user is None or user.disabled:
            raise HTTPException(401, "账号已停用")
        if not row.last_used_at or now - row.last_used_at > 60:
            row.last_used_at = now
            if via == "web":  # sliding session
                row.expires_at = now + int(c.config.session_hours * 3600)
            s.commit()
        p = Principal(user.id, user.username, user.role, via, row.id)
        # 系统设置「管理员必须开启两步验证」: until they do, only the account endpoints work.
        if (via == "web" and user.role == "admin" and not user.totp_enabled
                and not request.url.path.startswith(TOTP_EXEMPT)):
            required = s.get(Setting, "require_totp_admin")
            if required is not None and required.value:
                raise HTTPException(403, "请先开启两步验证")
    request.state.principal = p
    return p


def require(role: str) -> Callable[..., Principal]:
    def dep(p: Principal = Depends(current_user)) -> Principal:
        if not p.at_least(role):
            raise HTTPException(403, "权限不足")
        return p

    return dep


viewer = require("viewer")
operator = require("operator")
admin = require("admin")


def record(request: Request, s: Session, p: Principal | str, action: str, target: str = "",
           detail: dict[str, Any] | None = None) -> None:
    actor = p if isinstance(p, str) else p.username
    audit(s, actor, action, target, detail, client_ip(request))


def pub_limit(request: Request) -> None:
    """Dependency for public endpoints: too many requests from one IP → 429."""
    c = ctx(request)
    if c.pub_limiter is not None and not c.pub_limiter.allow(client_ip(request)):
        raise HTTPException(429, "请求太频繁，请稍后再试")


def apk_limit(request: Request) -> None:
    """Large downloads (APKs, bundles) get a tighter budget than JSON."""
    c = ctx(request)
    if c.apk_limiter is not None and not c.apk_limiter.allow(client_ip(request)):
        raise HTTPException(429, "下载太频繁，请稍后再试")


def like_escape(text: str) -> str:
    """Escape LIKE wildcards so user input matches literally; use with ``.like(..., escape="\\")``."""
    return text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def like_contains(text: str) -> str:
    """``%text%`` for a substring search on user input (wildcards in it are matched literally)."""
    return "%" + like_escape(text.strip()) + "%"


def paginate(page: int, page_size: int) -> tuple[int, int]:
    page = max(1, page)
    page_size = min(max(1, page_size), 500)
    return (page - 1) * page_size, page_size
