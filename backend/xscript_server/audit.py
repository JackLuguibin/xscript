"""Audit log helpers and small key/value settings."""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from .models import AuditLog, Setting

DEFAULT_SETTINGS: dict[str, Any] = {
    "site_name": "XScript 管理后台",
    # Public base URL of this server, e.g. https://cloud.example.com. Used for the 卡密 server
    # and 云控 URL baked into packed apps.
    "public_url": "",
    # 存储清理 (0 = keep everything)
    "keep_pack_jobs": 20,      # finished jobs whose APK and log are kept
    "audit_days": 180,
    "backup_daily": True,      # automatic backup once a day at backup_hour
    "backup_hour": 4,
    "keep_backups": 7,
    # 告警通知: webhook URLs and which events go there
    "alert_webhooks": [],      # [{"name", "kind": wecom|dingtalk|feishu|generic, "url", "events": [...]}]
    "alert_offline_minutes": 5,  # device offline this long → alert (0 = off)
    "require_totp_admin": False,   # admins must enable 两步验证 before using the console
    "device_log_days": 7,          # 运行日志 history kept on the server (0 = don't store)
}

ALERT_EVENTS = {
    "device_offline": "设备离线",
    "device_online": "设备恢复在线",
    "script_crash": "脚本异常退出",
    "pack_failed": "打包失败",
    "pack_succeeded": "打包成功",
    "task_failed": "定时任务失败",
    "cards_low": "未使用卡密不足",
}


def audit(s: Session, actor: str, action: str, target: str = "", detail: dict[str, Any] | None = None,
          ip: str = "") -> None:
    """Adds a row; the caller commits together with the change it describes."""
    s.add(AuditLog(actor=actor, action=action, target=str(target)[:255], detail=detail or {}, ip=ip or ""))


def get_settings(s: Session) -> dict[str, Any]:
    out = dict(DEFAULT_SETTINGS)
    for row in s.query(Setting).all():
        if row.key in out:
            out[row.key] = row.value
    return out


def set_setting(s: Session, key: str, value: Any) -> None:
    if key not in DEFAULT_SETTINGS:
        raise KeyError(key)
    row = s.get(Setting, key)
    if row is None:
        s.add(Setting(key=key, value=value))
    else:
        row.value = value
