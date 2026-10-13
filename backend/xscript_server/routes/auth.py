"""Login, sessions, password change and personal API tokens."""

from __future__ import annotations

import time

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from .. import totp
from ..audit import get_settings
from ..deps import SESSION_COOKIE, Principal, client_ip, ctx, current_user, db_session, record, viewer
from ..models import AuthToken, User
from ..security import DUMMY_HASH, check_password_policy, hash_password, new_secret, token_hash, verify_password

router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginIn(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)
    code: str = Field(default="", max_length=16)  # 两步验证 code, when enabled


class PasswordIn(BaseModel):
    old_password: str = Field(max_length=256)
    new_password: str = Field(max_length=256)


class TokenIn(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    days: int = Field(default=90, ge=0, le=3650)  # 0 = never expires


def agent_label(ua: str) -> str:
    """'Chrome · macOS' from a User-Agent, good enough to tell sessions apart."""
    browser = next((name for key, name in (("Edg/", "Edge"), ("OPR/", "Opera"), ("Firefox/", "Firefox"),
                                           ("MicroMessenger", "微信"), ("Chrome/", "Chrome"), ("Safari/", "Safari"))
                    if key in ua), "")
    system = next((name for key, name in (("Android", "Android"), ("iPhone", "iOS"), ("iPad", "iPadOS"),
                                          ("Windows", "Windows"), ("Mac OS X", "macOS"), ("Linux", "Linux"))
                   if key in ua), "")
    label = " · ".join(x for x in (browser, system) if x)
    return (label or ua[:40] or "未知")[:64]


def user_out(u: User, require_totp: bool = False) -> dict:
    return {"id": u.id, "username": u.username, "role": u.role, "disabled": u.disabled,
            "created_at": u.created_at, "last_login_at": u.last_login_at, "totp_enabled": bool(u.totp_enabled),
            # Admins must turn on 两步验证 first when the setting requires it (the console shows setup).
            "needs_totp_setup": bool(require_totp and u.role == "admin" and not u.totp_enabled)}


def _require_totp(s: Session) -> bool:
    return bool(get_settings(s).get("require_totp_admin"))


@router.post("/login")
def login(body: LoginIn, request: Request, response: Response, s: Session = Depends(db_session)):
    c = ctx(request)
    ip = client_ip(request)
    key = ip + "|" + body.username.lower()
    wait = c.limiter.blocked(key)
    if wait:
        raise HTTPException(429, "尝试次数过多，请 %d 秒后再试" % wait)
    user = s.scalar(select(User).where(User.username == body.username))
    ok = verify_password(body.password, user.password_hash if user else DUMMY_HASH)
    if not ok or user is None or user.disabled:
        c.limiter.fail(key)
        record(request, s, body.username, "auth.login_failed")
        s.commit()
        raise HTTPException(401, "用户名或密码错误")
    if user.totp_enabled:
        if not body.code:
            # Password is right; ask for the second factor. No session yet.
            return JSONResponse({"totp_required": True}, status_code=200)
        step = totp.verify(user.totp_secret or "", body.code, user.totp_last_step)
        if step is None:
            c.limiter.fail(key)
            record(request, s, body.username, "auth.totp_failed")
            s.commit()
            raise HTTPException(401, "验证码错误或已使用")
        user.totp_last_step = step
    c.limiter.reset(key)
    token = new_secret("xsw_")
    now = int(time.time())
    ttl = int(c.config.session_hours * 3600)
    # Sessions keep a short browser label in `name` for the 登录设备 list.
    s.add(AuthToken(user_id=user.id, token_hash=token_hash(token), kind="web", created_at=now,
                    expires_at=now + ttl, last_used_at=now, ip=ip,
                    name=agent_label(request.headers.get("user-agent", ""))))
    # Drop this user's expired sessions.
    s.execute(delete(AuthToken).where(AuthToken.user_id == user.id, AuthToken.kind == "web",
                                      AuthToken.expires_at <= now))
    user.last_login_at = now
    record(request, s, user.username, "auth.login")
    s.commit()
    response.set_cookie(SESSION_COOKIE, token, max_age=ttl, httponly=True, samesite="strict",
                        secure=request.url.scheme == "https", path="/")
    return user_out(user, _require_totp(s))


@router.post("/logout")
def logout(request: Request, response: Response, p: Principal = Depends(current_user),
           s: Session = Depends(db_session)):
    if p.via == "web":
        s.execute(delete(AuthToken).where(AuthToken.id == p.token_id))
        s.commit()
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"ok": True}


@router.get("/me")
def me(p: Principal = Depends(viewer), s: Session = Depends(db_session)):
    return user_out(s.get(User, p.id), _require_totp(s))


# ---------------------------------------------------------------- 两步验证

class TotpCode(BaseModel):
    code: str = Field(min_length=6, max_length=16)


class TotpDisable(BaseModel):
    password: str = Field(min_length=1, max_length=256)
    code: str = Field(min_length=6, max_length=16)


@router.post("/totp/setup")
def totp_setup(request: Request, p: Principal = Depends(viewer), s: Session = Depends(db_session)):
    """Start enrolment: a new pending secret and the otpauth:// URI for the QR code."""
    if p.via != "web":
        raise HTTPException(403, "只能在网页里设置两步验证")
    user = s.get(User, p.id)
    if user.totp_enabled:
        raise HTTPException(400, "已经开启两步验证")
    user.totp_secret = totp.new_secret()
    s.commit()
    issuer = get_settings(s).get("site_name") or "XScript"
    return {"secret": user.totp_secret, "uri": totp.provisioning_uri(user.totp_secret, user.username, issuer)}


@router.post("/totp/enable")
def totp_enable(body: TotpCode, request: Request, p: Principal = Depends(viewer), s: Session = Depends(db_session)):
    user = s.get(User, p.id)
    if user.totp_enabled or not user.totp_secret:
        raise HTTPException(400, "先获取二维码")
    step = totp.verify(user.totp_secret, body.code)
    if step is None:
        raise HTTPException(400, "验证码不对，检查手机时间是否准确")
    user.totp_enabled, user.totp_last_step = True, step
    # Other sessions were created without the second factor.
    s.execute(delete(AuthToken).where(AuthToken.user_id == user.id, AuthToken.kind == "web",
                                      AuthToken.id != p.token_id))
    record(request, s, p, "auth.totp_enable")
    s.commit()
    return user_out(user, _require_totp(s))


@router.post("/totp/disable")
def totp_disable(body: TotpDisable, request: Request, p: Principal = Depends(viewer),
                 s: Session = Depends(db_session)):
    user = s.get(User, p.id)
    if not user.totp_enabled:
        raise HTTPException(400, "没有开启两步验证")
    if user.role == "admin" and _require_totp(s):
        raise HTTPException(400, "系统要求管理员必须开启两步验证")
    if not verify_password(body.password, user.password_hash):
        raise HTTPException(400, "密码不正确")
    step = totp.verify(user.totp_secret or "", body.code, user.totp_last_step)
    if step is None:
        raise HTTPException(400, "验证码错误或已使用")
    user.totp_enabled, user.totp_secret, user.totp_last_step = False, None, None
    record(request, s, p, "auth.totp_disable")
    s.commit()
    return user_out(user, _require_totp(s))


@router.post("/password")
def change_password(body: PasswordIn, request: Request, p: Principal = Depends(viewer),
                    s: Session = Depends(db_session)):
    user = s.get(User, p.id)
    if not verify_password(body.old_password, user.password_hash):
        raise HTTPException(400, "原密码不正确")
    try:
        check_password_policy(body.new_password)
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    user.password_hash = hash_password(body.new_password)
    # Sign out every other session.
    s.execute(delete(AuthToken).where(AuthToken.user_id == user.id, AuthToken.kind == "web",
                                      AuthToken.id != p.token_id))
    record(request, s, p, "auth.password")
    s.commit()
    return {"ok": True}


@router.get("/sessions")
def list_sessions(p: Principal = Depends(viewer), s: Session = Depends(db_session)):
    """This user's browser sessions (登录设备)."""
    now = int(time.time())
    rows = s.scalars(select(AuthToken).where(AuthToken.user_id == p.id, AuthToken.kind == "web",
                                             AuthToken.expires_at > now).order_by(AuthToken.last_used_at.desc()))
    return {"items": [{"id": t.id, "ip": t.ip, "agent": t.name, "created_at": t.created_at,
                       "last_used_at": t.last_used_at, "expires_at": t.expires_at,
                       "current": p.via == "web" and t.id == p.token_id} for t in rows]}


@router.delete("/sessions/{session_id}")
def end_session(session_id: int, request: Request, p: Principal = Depends(viewer), s: Session = Depends(db_session)):
    row = s.get(AuthToken, session_id)
    if row is None or row.user_id != p.id or row.kind != "web":
        raise HTTPException(404, "会话不存在")
    s.delete(row)
    record(request, s, p, "auth.logout_session", row.ip)
    s.commit()
    return {"ok": True}


@router.post("/sessions/logout-others")
def end_other_sessions(request: Request, p: Principal = Depends(viewer), s: Session = Depends(db_session)):
    res = s.execute(delete(AuthToken).where(AuthToken.user_id == p.id, AuthToken.kind == "web",
                                            AuthToken.id != (p.token_id if p.via == "web" else -1)))
    record(request, s, p, "auth.logout_others", "", {"count": res.rowcount or 0})
    s.commit()
    return {"ended": res.rowcount or 0}


@router.get("/tokens")
def list_tokens(p: Principal = Depends(viewer), s: Session = Depends(db_session)):
    rows = s.scalars(select(AuthToken).where(AuthToken.user_id == p.id, AuthToken.kind == "api")
                     .order_by(AuthToken.id.desc()))
    return {"items": [{"id": t.id, "name": t.name, "created_at": t.created_at, "expires_at": t.expires_at,
                       "last_used_at": t.last_used_at} for t in rows]}


@router.post("/tokens")
def create_token(body: TokenIn, request: Request, p: Principal = Depends(viewer), s: Session = Depends(db_session)):
    if p.via != "web":
        raise HTTPException(403, "API 令牌只能在网页里创建")
    token = new_secret("xsk_")
    now = int(time.time())
    row = AuthToken(user_id=p.id, token_hash=token_hash(token), kind="api", name=body.name, created_at=now,
                    expires_at=now + body.days * 86400 if body.days else None, ip=client_ip(request))
    s.add(row)
    record(request, s, p, "token.create", body.name)
    s.commit()
    # The plain token is only returned once.
    return {"id": row.id, "name": row.name, "token": token, "expires_at": row.expires_at}


@router.delete("/tokens/{token_id}")
def delete_token(token_id: int, request: Request, p: Principal = Depends(viewer), s: Session = Depends(db_session)):
    row = s.get(AuthToken, token_id)
    if row is None or row.user_id != p.id or row.kind != "api":
        raise HTTPException(404, "令牌不存在")
    s.delete(row)
    record(request, s, p, "token.delete", row.name)
    s.commit()
    return {"ok": True}
