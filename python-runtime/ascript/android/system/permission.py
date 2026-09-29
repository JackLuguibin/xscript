"""Runtime permission helpers (subset). Special grants open the matching settings page."""

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

GRANTED = 0
DENIED = -1
TIMEOUT = -2
UNSUPPORTED = -3
DEFAULT_TIMEOUT = 60


def has(key):
    if key == OVERLAY:
        return bridge.ui("can_overlay", {}) == "true"
    if key == ACCESSIBILITY_SERVICE:
        return bridge.is_accessibility_on()
    return False


is_granted = has


def request(key, timeout=DEFAULT_TIMEOUT):
    return GRANTED if has(key) else UNSUPPORTED


def ensure(key, timeout=DEFAULT_TIMEOUT):
    return has(key)


def list_all():
    return [OVERLAY, ACCESSIBILITY_SERVICE]
