"""Tables. Timestamps are epoch seconds (int), matching the device protocol and 卡密 tokens."""

from __future__ import annotations

import time
from typing import Any

from sqlalchemy import JSON, BigInteger, Boolean, Float, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def now() -> int:
    return int(time.time())


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(16), default="viewer")  # viewer | operator | admin
    disabled: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[int] = mapped_column(Integer, default=now)
    last_login_at: Mapped[int | None] = mapped_column(Integer, default=None)
    # 两步验证 (TOTP). The secret is pending until totp_enabled; totp_last_step blocks code replay.
    totp_secret: Mapped[str | None] = mapped_column(String(64), default=None)
    totp_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    totp_last_step: Mapped[int | None] = mapped_column(Integer, default=None)


class DeviceLog(Base):
    """Script log lines pushed by devices (运行日志 history). ts is epoch milliseconds."""

    __tablename__ = "device_logs"
    __table_args__ = (Index("ix_device_logs_device_ts", "device", "ts"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    device: Mapped[str] = mapped_column(String(200))
    seq: Mapped[int] = mapped_column(BigInteger, default=0)
    ts: Mapped[int] = mapped_column(BigInteger, default=0)
    stream: Mapped[str] = mapped_column(String(8), default="stdout")
    line: Mapped[str] = mapped_column(Text, default="")


class AuthToken(Base):
    """Browser sessions (kind=web, cookie) and API tokens (kind=api, Bearer). Only hashes are stored."""

    __tablename__ = "auth_tokens"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    kind: Mapped[str] = mapped_column(String(8), default="web")
    name: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[int] = mapped_column(Integer, default=now)
    expires_at: Mapped[int | None] = mapped_column(Integer, default=None)
    last_used_at: Mapped[int | None] = mapped_column(Integer, default=None)
    ip: Mapped[str] = mapped_column(String(64), default="")


class DeviceKey(Base):
    """Secrets devices put in the 云控 URL (ws://host/ws?token=...). Only hashes are stored."""

    __tablename__ = "device_keys"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(64))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    hint: Mapped[str] = mapped_column(String(16), default="")
    created_at: Mapped[int] = mapped_column(Integer, default=now)
    created_by: Mapped[str] = mapped_column(String(64), default="")
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)
    last_used_at: Mapped[int | None] = mapped_column(Integer, default=None)


class Device(Base):
    """Every app that ever connected. id is device_id, or device_id@package for packaged apps."""

    __tablename__ = "devices"

    id: Mapped[str] = mapped_column(String(200), primary_key=True)
    device_id: Mapped[str] = mapped_column(String(128), index=True)
    app: Mapped[str] = mapped_column(String(128), default="")
    model: Mapped[str] = mapped_column(String(128), default="")
    brand: Mapped[str] = mapped_column(String(64), default="")
    reported_group: Mapped[str] = mapped_column(String(64), default="")
    group_override: Mapped[str] = mapped_column(String(64), default="")
    note: Mapped[str] = mapped_column(String(255), default="")
    status: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    data: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    remote: Mapped[str] = mapped_column(String(64), default="")
    key_id: Mapped[int | None] = mapped_column(Integer, default=None)
    # Last finished run reported by the device: {"project", "exit", "time", "crashed", "tail"}.
    last_run: Mapped[dict[str, Any] | None] = mapped_column(JSON, default=None)
    first_seen: Mapped[int] = mapped_column(Integer, default=now)
    last_seen: Mapped[int] = mapped_column(Integer, default=now)


class Task(Base):
    """Server-side 定时任务: send a command to a target daily at HH:MM or every N minutes."""

    __tablename__ = "tasks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(64), default="")
    target: Mapped[str] = mapped_column(String(512), default="all")
    command: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    daily: Mapped[str | None] = mapped_column(String(5), default=None)
    every: Mapped[float | None] = mapped_column(Float, default=None)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    last_run: Mapped[float] = mapped_column(Float, default=0.0)
    last_result: Mapped[dict[str, Any] | None] = mapped_column(JSON, default=None)
    created_by: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[int] = mapped_column(Integer, default=now)


class Card(Base):
    """卡密. Bound to the first device that activates it; validity counts from activation."""

    __tablename__ = "cards"

    card: Mapped[str] = mapped_column(String(40), primary_key=True)
    batch: Mapped[str] = mapped_column(String(32), default="", index=True)
    days: Mapped[float] = mapped_column(Float, default=0.0)  # 0 = permanent
    app: Mapped[str] = mapped_column(String(128), default="*")
    note: Mapped[str] = mapped_column(String(255), default="")
    created_at: Mapped[int] = mapped_column(Integer, default=now)
    device: Mapped[str | None] = mapped_column(String(128), default=None, index=True)
    model: Mapped[str | None] = mapped_column(String(128), default=None)
    activated_at: Mapped[int | None] = mapped_column(Integer, default=None)
    expires_at: Mapped[int | None] = mapped_column(Integer, default=None)  # 0 = permanent
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)
    last_verified_at: Mapped[int | None] = mapped_column(Integer, default=None)
    # 体验卡 (trial): one per device and app. Normal cards may stack onto a running one (续期叠加).
    kind: Mapped[str] = mapped_column(String(8), default="normal")  # normal | trial
    # 多设备卡: how many devices may share the card. `device` is the first one bound; the rest are in `extras`.
    max_devices: Mapped[int] = mapped_column(Integer, default=1)
    stack: Mapped[bool] = mapped_column(Boolean, default=True)
    extras: Mapped[list["CardDevice"]] = relationship(cascade="all, delete-orphan", lazy="selectin",
                                                       order_by="CardDevice.id")


class CardDevice(Base):
    """Second and later devices of a 多设备卡 (the first one lives on Card.device)."""

    __tablename__ = "card_devices"
    __table_args__ = (UniqueConstraint("card", "device"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    card: Mapped[str] = mapped_column(ForeignKey("cards.card", ondelete="CASCADE"), index=True)
    device: Mapped[str] = mapped_column(String(128), index=True)
    model: Mapped[str] = mapped_column(String(128), default="")
    bound_at: Mapped[int] = mapped_column(Integer, default=now)


class TrialUse(Base):
    """A device that has used a 体验卡 for an app; survives 解绑 and deleting the card."""

    __tablename__ = "trial_uses"
    __table_args__ = (UniqueConstraint("device", "app"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    device: Mapped[str] = mapped_column(String(128))
    app: Mapped[str] = mapped_column(String(128))
    card: Mapped[str] = mapped_column(String(40), default="")
    used_at: Mapped[int] = mapped_column(Integer, default=now)


class Announcement(Base):
    """公告 shown by packaged apps at start-up (plain text). app is a package name or * for every app."""

    __tablename__ = "announcements"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    app: Mapped[str] = mapped_column(String(128), default="*", index=True)
    title: Mapped[str] = mapped_column(String(120), default="")
    body: Mapped[str] = mapped_column(Text, default="")
    level: Mapped[str] = mapped_column(String(8), default="info")  # info | warning | urgent
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    starts_at: Mapped[int | None] = mapped_column(Integer, default=None)
    ends_at: Mapped[int | None] = mapped_column(Integer, default=None)
    created_by: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[int] = mapped_column(Integer, default=now)
    updated_at: Mapped[int] = mapped_column(Integer, default=now)


class AppUpdate(Base):
    """APK 更新策略 per packed app: the newest version, the oldest one still allowed (强制更新) and where to get it."""

    __tablename__ = "app_updates"

    app: Mapped[str] = mapped_column(String(128), primary_key=True)
    latest_code: Mapped[int] = mapped_column(Integer, default=0)
    latest_name: Mapped[str] = mapped_column(String(32), default="")
    min_code: Mapped[int] = mapped_column(Integer, default=0)  # clients below this must update (0 = nobody)
    job_id: Mapped[int | None] = mapped_column(ForeignKey("pack_jobs.id", ondelete="SET NULL"), default=None)
    url: Mapped[str] = mapped_column(String(512), default="")  # external download page / file when no job
    sha256: Mapped[str] = mapped_column(String(64), default="")
    size: Mapped[int] = mapped_column(Integer, default=0)
    notes: Mapped[str] = mapped_column(Text, default="")
    updated_by: Mapped[str] = mapped_column(String(64), default="")
    updated_at: Mapped[int] = mapped_column(Integer, default=now)


class AuditLog(Base):
    __tablename__ = "audit_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    time: Mapped[int] = mapped_column(Integer, default=now, index=True)
    actor: Mapped[str] = mapped_column(String(64), default="")
    action: Mapped[str] = mapped_column(String(64), index=True)
    target: Mapped[str] = mapped_column(String(255), default="")
    detail: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    ip: Mapped[str] = mapped_column(String(64), default="")


class PackJob(Base):
    __tablename__ = "pack_jobs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    status: Mapped[str] = mapped_column(String(16), default="queued")  # queued running succeeded failed cancelled
    app_id: Mapped[str] = mapped_column(String(128))
    app_name: Mapped[str] = mapped_column(String(64), default="")
    version: Mapped[str] = mapped_column(String(32), default="1.0.0")
    version_code: Mapped[int] = mapped_column(Integer, default=1)
    project_name: Mapped[str] = mapped_column(String(64), default="")
    options: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_by: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[int] = mapped_column(Integer, default=now)
    started_at: Mapped[int | None] = mapped_column(Integer, default=None)
    finished_at: Mapped[int | None] = mapped_column(Integer, default=None)
    apk_file: Mapped[str | None] = mapped_column(String(255), default=None)
    apk_size: Mapped[int | None] = mapped_column(Integer, default=None)
    error: Mapped[str | None] = mapped_column(Text, default=None)


class Script(Base):
    """小程序: a project with versions. `channel` is the public id packed apps use for 热更新."""

    __tablename__ = "scripts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(64))
    project_name: Mapped[str] = mapped_column(String(64))
    description: Mapped[str] = mapped_column(Text, default="")
    protect: Mapped[bool] = mapped_column(Boolean, default=False)  # ship bytecode only
    channel: Mapped[str] = mapped_column(String(64), unique=True)
    current_version_id: Mapped[int | None] = mapped_column(Integer, default=None)
    created_by: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[int] = mapped_column(Integer, default=now)
    updated_at: Mapped[int] = mapped_column(Integer, default=now)


class ScriptVersion(Base):
    __tablename__ = "script_versions"
    __table_args__ = (UniqueConstraint("script_id", "version_code"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    script_id: Mapped[int] = mapped_column(ForeignKey("scripts.id", ondelete="CASCADE"), index=True)
    version: Mapped[str] = mapped_column(String(32))
    version_code: Mapped[int] = mapped_column(Integer)
    notes: Mapped[str] = mapped_column(Text, default="")
    sha256: Mapped[str] = mapped_column(String(64))  # of the stored source zip
    size: Mapped[int] = mapped_column(Integer, default=0)
    files: Mapped[int] = mapped_column(Integer, default=0)
    downloads: Mapped[int] = mapped_column(Integer, default=0)  # 热更新 bundle fetches
    created_by: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[int] = mapped_column(Integer, default=now)


class ShareLink(Base):
    """Public download link (分发) for a finished pack job."""

    __tablename__ = "share_links"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    job_id: Mapped[int] = mapped_column(ForeignKey("pack_jobs.id", ondelete="CASCADE"), index=True)
    token: Mapped[str] = mapped_column(String(64), unique=True)
    created_by: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[int] = mapped_column(Integer, default=now)
    expires_at: Mapped[int | None] = mapped_column(Integer, default=None)
    downloads: Mapped[int] = mapped_column(Integer, default=0)
    disabled: Mapped[bool] = mapped_column(Boolean, default=False)


class Setting(Base):
    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[Any] = mapped_column(JSON, default=None)
