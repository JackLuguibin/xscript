"""User management (admin only)."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from ..deps import Principal, admin, db_session, record
from ..models import AuthToken, Reseller, User
from ..security import check_password_policy, hash_password
from .auth import user_out

router = APIRouter(prefix="/api/users", tags=["users"])

Role = Literal["viewer", "operator", "admin", "reseller"]  # reseller = 代理 (own cards only, see routes/reseller.py)


class UserIn(BaseModel):
    username: str = Field(min_length=2, max_length=64, pattern=r"^[\w.@-]+$")
    password: str = Field(max_length=256)
    role: Role = "viewer"


class UserPatch(BaseModel):
    role: Role | None = None
    disabled: bool | None = None
    password: str | None = Field(default=None, max_length=256)
    reset_totp: bool | None = None  # 手机丢了：清除对方的两步验证，下次登录重新设置


def _admins(s: Session) -> int:
    return s.scalar(select(func.count()).select_from(User).where(User.role == "admin", User.disabled.is_(False))) or 0


def _ensure_reseller(s: Session, user_id: int) -> None:
    """New 代理 start with no quota; an admin grants cards on the 代理 page."""
    if s.get(Reseller, user_id) is None:
        s.add(Reseller(user_id=user_id, apps=["*"], kinds=["normal"]))


@router.get("")
def list_users(p: Principal = Depends(admin), s: Session = Depends(db_session)):
    return {"items": [user_out(u) for u in s.scalars(select(User).order_by(User.id))]}


@router.post("")
def create_user(body: UserIn, request: Request, p: Principal = Depends(admin), s: Session = Depends(db_session)):
    if s.scalar(select(User).where(User.username == body.username)):
        raise HTTPException(409, "用户名已存在")
    try:
        check_password_policy(body.password)
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    u = User(username=body.username, password_hash=hash_password(body.password), role=body.role)
    s.add(u)
    if body.role == "reseller":
        s.flush()
        _ensure_reseller(s, u.id)
    record(request, s, p, "user.create", body.username, {"role": body.role})
    s.commit()
    return user_out(u)


@router.patch("/{user_id}")
def update_user(user_id: int, body: UserPatch, request: Request, p: Principal = Depends(admin),
                s: Session = Depends(db_session)):
    u = s.get(User, user_id)
    if u is None:
        raise HTTPException(404, "用户不存在")
    losing_admin = u.role == "admin" and not u.disabled and (
        (body.role is not None and body.role != "admin") or body.disabled is True)
    if losing_admin and _admins(s) <= 1:
        raise HTTPException(400, "至少要保留一个启用的管理员")
    detail: dict = {}
    if body.role is not None and body.role != u.role:
        u.role = detail["role"] = body.role
        if body.role == "reseller":
            _ensure_reseller(s, u.id)
        # A role change ends the account's sessions and API tokens so no request keeps the old scope.
        s.execute(delete(AuthToken).where(AuthToken.user_id == u.id))
    if body.disabled is not None:
        u.disabled = detail["disabled"] = body.disabled
    if body.password:
        try:
            check_password_policy(body.password)
        except ValueError as e:
            raise HTTPException(400, str(e)) from None
        u.password_hash = hash_password(body.password)
        detail["password"] = "reset"
    if body.reset_totp:
        if u.id == p.id:
            raise HTTPException(400, "在「账号与令牌」里关闭自己的两步验证")
        u.totp_enabled, u.totp_secret, u.totp_last_step = False, None, None
        detail["totp"] = "reset"
    if body.disabled or body.password or body.reset_totp:
        s.execute(delete(AuthToken).where(AuthToken.user_id == u.id, AuthToken.kind == "web"))
    record(request, s, p, "user.update", u.username, detail)
    s.commit()
    return user_out(u)


@router.delete("/{user_id}")
def delete_user(user_id: int, request: Request, p: Principal = Depends(admin), s: Session = Depends(db_session)):
    u = s.get(User, user_id)
    if u is None:
        raise HTTPException(404, "用户不存在")
    if u.id == p.id:
        raise HTTPException(400, "不能删除自己")
    if u.role == "admin" and not u.disabled and _admins(s) <= 1:
        raise HTTPException(400, "至少要保留一个启用的管理员")
    s.delete(u)
    record(request, s, p, "user.delete", u.username)
    s.commit()
    return {"ok": True}
