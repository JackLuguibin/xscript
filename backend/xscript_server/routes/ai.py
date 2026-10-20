"""后台 AI 写脚本: generate or revise a 小程序 entry with the configured model, then save it as a version.

Generating spends model tokens and saving adds a version, so both need operator (like uploading a version);
publishing and deploying stay on the 小程序 endpoints (admin). Prompts are not logged, only their size.
"""

from __future__ import annotations

import shutil
import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from .. import aiwriter
from .. import scripts as store
from ..audit import get_settings
from ..deps import Principal, ctx, db_session, operator, record, viewer
from ..models import Script, ScriptVersion
from .scripts import VERSION_RE, store_version

router = APIRouter(prefix="/api/ai", tags=["ai"])

MAX_CODE = 200_000


class GenerateIn(BaseModel):
    prompt: str = Field(min_length=1, max_length=4000)
    code: str = Field(default="", max_length=MAX_CODE)  # current entry to revise ("" = write from scratch)


class SaveIn(BaseModel):
    script_id: int
    code: str = Field(min_length=1, max_length=MAX_CODE)
    base_version_id: int | None = None  # keep this version's other files (resources, requirements.txt)
    version: str = Field(default="", max_length=32, pattern=r"^(|%s)$" % VERSION_RE.strip("^$"))
    notes: str = Field(default="", max_length=4000)
    publish: bool = False


def _settings(c) -> dict[str, Any]:
    with c.db.session() as s:
        return get_settings(s)


@router.get("/status")
def status(p: Principal = Depends(viewer), s: Session = Depends(db_session)):
    """Whether a model is configured and which; never includes the key."""
    return aiwriter.public_status(get_settings(s))


@router.post("/script")
async def generate(body: GenerateIn, request: Request, p: Principal = Depends(operator)):
    c = ctx(request)
    if c.ai_limiter is not None and not c.ai_limiter.allow(str(p.id)):
        raise HTTPException(429, "生成太频繁，请稍后再试（每人每 10 分钟 20 次）")
    cfg = aiwriter.resolve(await run_in_threadpool(_settings, c))
    messages = aiwriter.build_messages(body.prompt, body.code)
    err: aiwriter.AiError | None = None
    try:
        reply = await run_in_threadpool(aiwriter.chat, cfg, messages)
    except aiwriter.AiError as e:
        err, reply = e, None

    out: dict[str, Any] = {}
    if reply is not None:
        code, notes = aiwriter.extract(reply["text"])
        out = {"code": code, "notes": notes, "syntax_error": aiwriter.check_syntax(code), "model": cfg["model"],
               "usage": reply["usage"], "ms": reply["ms"]}

    def _audit():
        with c.db.session() as s:
            record(request, s, p, "ai.script", cfg["model"] or "-",
                   {"prompt_chars": len(body.prompt), "revise": bool(body.code.strip()), "ok": err is None,
                    **({"error": str(err)[:200]} if err else
                       {"code_chars": len(out["code"]), "syntax_ok": not out["syntax_error"], **out["usage"]})})
            s.commit()

    if err is None or err.status != 400:  # "not configured" is not worth a log row
        await run_in_threadpool(_audit)
    if err is not None:
        raise HTTPException(err.status, str(err))
    return out


@router.get("/source/{script_id}/{version_id}")
def source(script_id: int, version_id: int, request: Request, p: Principal = Depends(operator),
           s: Session = Depends(db_session)):
    """A version's __init__.py, to revise it with the model."""
    v = s.get(ScriptVersion, version_id)
    if s.get(Script, script_id) is None or v is None or v.script_id != script_id:
        raise HTTPException(404, "版本不存在")
    path = store.version_dir(ctx(request).config, script_id, version_id) / "source.zip"
    if not path.is_file():
        raise HTTPException(404, "文件已丢失")
    try:
        code = aiwriter.read_entry(path)
    except aiwriter.AiError as e:
        raise HTTPException(e.status, str(e)) from None
    except Exception as e:
        raise HTTPException(400, "读取工程失败: %s" % e) from None
    return {"code": code, "version": v.version}


@router.post("/save")
async def save(body: SaveIn, request: Request, p: Principal = Depends(operator)):
    """Save generated code as the next version of a 小程序 (other files copied from base_version_id)."""
    c = ctx(request)
    syntax = aiwriter.check_syntax(body.code)
    if syntax:
        raise HTTPException(400, "代码有语法错误，修正后再保存（%s）" % syntax)

    def _run():
        base = None
        if body.base_version_id is not None:
            with c.db.session() as s:
                v = s.get(ScriptVersion, body.base_version_id)
                if v is None or v.script_id != body.script_id:
                    raise HTTPException(404, "基础版本不存在")
            base = store.version_dir(c.config, body.script_id, body.base_version_id) / "source.zip"
            if not base.is_file():
                raise HTTPException(404, "基础版本的文件已丢失")
        with c.db.session() as s:
            if s.get(Script, body.script_id) is None:
                raise HTTPException(404, "小程序不存在")
        tmp_dir = c.config.scripts_dir / str(body.script_id) / (".ai-%d" % time.time_ns())
        tmp_dir.mkdir(parents=True, exist_ok=True)
        try:
            src = tmp_dir / "source.zip"
            try:
                aiwriter.project_zip(src, body.code, base)
            except Exception as e:
                raise HTTPException(400, "生成工程失败: %s" % e) from None
            if src.stat().st_size > store.MAX_SOURCE_ZIP:
                raise HTTPException(413, "工程太大")
            notes = body.notes or "AI 写脚本生成"
            return store_version(c, request, p, body.script_id, src, src.stat().st_size, body.version, notes,
                                 body.publish, {"ai": True, "base_version_id": body.base_version_id})
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)

    return await run_in_threadpool(_run)
