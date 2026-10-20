"""Audit log helpers and small key/value settings."""

from __future__ import annotations

import copy
import time
from typing import Any

from sqlalchemy import event
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
    # 卡密滥用告警 thresholds within 24 h (0 = that check is off)
    "abuse_card_devices": 3,       # distinct devices turned away from one card
    "abuse_device_cards": 5,       # cards activated by one device
    "abuse_ip_devices": 10,        # devices activated from one IP
    "abuse_ip_failures": 5,        # unknown card codes tried from one IP
    # 登录 IP 白名单: IPs / CIDR ranges allowed to use the console and API ([] = anyone)
    "login_ip_allowlist": [],
    # 后台 AI 写脚本: override XSCRIPT_AI_BASE_URL / XSCRIPT_AI_MODEL ("" = use the environment).
    # The key (XSCRIPT_AI_KEY) is environment-only and never stored here.
    "ai_base_url": "",
    "ai_model": "",
}

ALERT_EVENTS = {
    "device_offline": "设备离线",
    "device_online": "设备恢复在线",
    "script_crash": "脚本异常退出",
    "pack_failed": "打包失败",
    "pack_succeeded": "打包成功",
    "task_failed": "定时任务失败",
    "cards_low": "未使用卡密不足",
    "card_abuse": "卡密滥用告警",
}


def audit(s: Session, actor: str, action: str, target: str = "", detail: dict[str, Any] | None = None,
          ip: str = "") -> None:
    """Adds a row; the caller commits together with the change it describes."""
    s.add(AuditLog(actor=actor, action=action, target=str(target)[:255], detail=detail or {}, ip=ip or ""))


# Settings are read on every authenticated request (IP allowlist, 2FA policy) and several times
# by some pages. Cached per database; set_setting() drops the cache when its transaction commits,
# and the short TTL picks up writes from another process (the CLI's reset-allowlist).
SETTINGS_TTL = 5.0
_settings_cache: dict[str, tuple[float, dict[str, Any]]] = {}  # database URL -> (expires, settings)


def get_settings(s: Session) -> dict[str, Any]:
    """All settings with defaults filled in. A copy: callers may modify it."""
    key = str(s.get_bind().url)
    hit = _settings_cache.get(key)
    now = time.monotonic()
    if hit is None or hit[0] <= now or s.info.get("settings_dirty"):
        out = dict(DEFAULT_SETTINGS)
        for row in s.query(Setting).all():
            if row.key in out:
                out[row.key] = row.value
        if s.info.get("settings_dirty"):
            return out  # uncommitted values of this session: never cached
        hit = (now + SETTINGS_TTL, out)
        _settings_cache[key] = hit
    return copy.deepcopy(hit[1])


def invalidate_settings(s: Session | None = None) -> None:
    if s is None:
        _settings_cache.clear()
    else:
        _settings_cache.pop(str(s.get_bind().url), None)


@event.listens_for(Session, "after_commit")
def _settings_committed(s: Session) -> None:
    if s.info.pop("settings_dirty", False):
        invalidate_settings(s)


@event.listens_for(Session, "after_rollback")
def _settings_rolled_back(s: Session) -> None:
    s.info.pop("settings_dirty", None)


def set_setting(s: Session, key: str, value: Any) -> None:
    if key not in DEFAULT_SETTINGS:
        raise KeyError(key)
    s.info["settings_dirty"] = True
    invalidate_settings(s)
    row = s.get(Setting, key)
    if row is None:
        s.add(Setting(key=key, value=value))
    else:
        row.value = value
