"""Runtime permission helpers (subset). Special grants open the matching settings page."""

import json
import math

from xscript.runtime.bridge import bridge

CAMERA = "android.permission.CAMERA"
RECORD_AUDIO = MICROPHONE = "android.permission.RECORD_AUDIO"
READ_SMS = SMS = "android.permission.READ_SMS"
READ_PHONE_STATE = PHONE = "android.permission.READ_PHONE_STATE"
READ_PHONE_NUMBERS = "android.permission.READ_PHONE_NUMBERS"
ACCESS_FINE_LOCATION = LOCATION = "android.permission.ACCESS_FINE_LOCATION"
ACCESS_COARSE_LOCATION = "android.permission.ACCESS_COARSE_LOCATION"
BLUETOOTH_CONNECT = BLUETOOTH = "android.permission.BLUETOOTH_CONNECT"
BLUETOOTH_SCAN = "android.permission.BLUETOOTH_SCAN"
POST_NOTIFICATIONS = NOTIFICATION = "android.permission.POST_NOTIFICATIONS"
READ_CONTACTS = CONTACTS = "android.permission.READ_CONTACTS"
READ_EXTERNAL_STORAGE = STORAGE = "android.permission.READ_EXTERNAL_STORAGE"
WRITE_EXTERNAL_STORAGE = "android.permission.WRITE_EXTERNAL_STORAGE"
ACCESSIBILITY_SERVICE = "accessibility"
NOTIFICATION_LISTENER = "notification_listener"
USAGE_STATS = "usage_stats"
SYSTEM_ALERT_WINDOW = OVERLAY = "overlay"
WRITE_SETTINGS = "write_settings"
MANAGE_EXTERNAL_STORAGE = "manage_storage"
INSTALL_PACKAGES = "install_packages"
SHIZUKU = "shizuku"

GRANTED = 1
DENIED = 0
TIMEOUT = -1
UNSUPPORTED = -2
DEFAULT_TIMEOUT = 60


def _key(key):
    if not isinstance(key, str) or not key.strip():
        raise ValueError("permission key must be a nonempty string")
    return key.strip()


def has(key):
    """Check the actual Android grant; undeclared/unknown keys return False."""
    return str(bridge.system("permission_has", {"key": _key(key)})).lower() == "true"


is_granted = has


def request(key, timeout=DEFAULT_TIMEOUT):
    """Runtime grants block for a result; Settings grants open a page and return DENIED."""
    key = _key(key)
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or not 0 < timeout <= 600:
        raise ValueError("timeout must be in (0, 600] seconds")
    value = bridge.system("permission_request", {"key": key, "timeout": timeout})
    return int(value) if value else UNSUPPORTED


def ensure(key, timeout=DEFAULT_TIMEOUT):
    return has(key) or request(key, timeout) == GRANTED


def list_all():
    raw = bridge.system("permission_list", {})
    return json.loads(str(raw)) if raw else []
