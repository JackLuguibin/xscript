"""Event listeners: keys, touches, notifications, toasts and raw accessibility events.

    from xscript.android import event

    @event.on_key(24)                      # volume up
    def vol(e):
        if e.action == "down":
            print("volume up")

    @event.on_notification(package="com.tencent.mm")
    def wx(e):
        print(e.title, e.text)
        e.send()                           # open the notification

    e = event.wait("toast", timeout=10)    # block until the next toast (or None)

Events come from the main app process. Handlers run one at a time on a background (daemon)
thread, so keep them short and keep the script alive yourself (a loop, or `event.loop()`).

Requirements: keys, touches, toasts and accessibility events need 无障碍. Notifications use
通知使用权 when granted (title, text, id, `send()`), and otherwise fall back to accessibility
notification events, which carry less data. Key events are observed, never consumed.
"""

import json
import threading
import time
import traceback

from xscript.runtime.bridge import bridge

KEY = "key"
TOUCH = "touch"
NOTIFICATION = "notification"
TOAST = "toast"
ACCESSIBILITY = "a11y"
CLOUD = "cloud"     # messages from the 云控 server (see xscript.android.cloud)
FLOAT = "float"     # a custom floating-window button was tapped (see xscript.android.ui.float_add_menu)
TYPES = (KEY, TOUCH, NOTIFICATION, TOAST, ACCESSIBILITY, CLOUD, FLOAT)

# Android key codes that scripts commonly listen for.
KEYCODE_HOME = 3
KEYCODE_BACK = 4
KEYCODE_VOLUME_UP = 24
KEYCODE_VOLUME_DOWN = 25
KEYCODE_POWER = 26
KEYCODE_MENU = 82


class Event(object):
    """One event. Fields are attributes (`e.text`) and keys (`e["text"]`); `e.type` is its kind."""

    def __init__(self, data):
        self.__dict__.update(data)
        self._data = data

    def __getitem__(self, key):
        return self._data[key]

    def get(self, key, default=None):
        return self._data.get(key, default)

    def to_dict(self):
        return dict(self._data)

    def send(self):
        """Notifications: open the notification (fire its contentIntent). Returns success."""
        key = self._data.get("key")
        if self._data.get("type") != NOTIFICATION or not key:
            return False
        return bridge.control("notification_send", str(key)) == "true"

    def __repr__(self):
        return "Event(%s)" % json.dumps(self._data, ensure_ascii=False)


class _Registry(object):
    def __init__(self):
        self.lock = threading.RLock()
        self.handlers = []          # [(token, type, match, fn)]
        self.waiters = []           # [(type, match, box, threading.Event)]
        self.a11y_mask = 0
        self.thread = None
        self.seq = 0
        self.subscribed = (frozenset(), 0)


_reg = _Registry()


def _matcher(filters):
    """Filters: field -> value, a list/tuple/set of values, or a callable(value) -> bool."""
    items = [(k, v) for k, v in filters.items() if v is not None]

    def match(data):
        for k, want in items:
            got = data.get(k)
            if callable(want):
                if not want(got):
                    return False
            elif isinstance(want, (list, tuple, set, frozenset)):
                if got not in want:
                    return False
            elif got != want:
                return False
        return True

    return match


def _sync():
    """Tell the main process which event types this script wants."""
    with _reg.lock:
        wanted = frozenset(t for _, t, _, _ in _reg.handlers) | frozenset(t for t, _, _, _ in _reg.waiters)
        state = (wanted, int(_reg.a11y_mask))
        if state == _reg.subscribed:
            return
        _reg.subscribed = state
        payload = {"types": sorted(wanted), "a11y_mask": state[1]}
    raw = bridge.control("events_subscribe", payload)
    if raw and raw.startswith("{") and '"error"' in raw:
        raise RuntimeError(json.loads(raw).get("error"))
    if wanted:
        _ensure_thread()


def _ensure_thread():
    with _reg.lock:
        if _reg.thread is not None and _reg.thread.is_alive():
            return
        _reg.thread = threading.Thread(target=_pump, name="xscript-events", daemon=True)
        _reg.thread.start()


def _pump():
    while True:
        try:
            raw = bridge.poll_event(500)
        except Exception:
            time.sleep(0.5)
            continue
        if not raw:
            with _reg.lock:
                if not _reg.handlers and not _reg.waiters:
                    _reg.thread = None
                    return
            continue
        try:
            dispatch(json.loads(raw))
        except Exception:
            traceback.print_exc()


def dispatch(data):
    """Deliver one event dict to matching waiters and handlers (used by the pump and by tests)."""
    etype = data.get("type")
    ev = Event(data)
    with _reg.lock:
        waiters = [w for w in _reg.waiters if w[0] == etype and w[1](data)]
        for w in waiters:
            _reg.waiters.remove(w)
        handlers = [fn for _, t, match, fn in _reg.handlers if t == etype and match(data)]
    for _, _, box, done in waiters:
        box.append(ev)
        done.set()
    for fn in handlers:
        try:
            fn(ev)
        except Exception:
            traceback.print_exc()
    if waiters:
        _sync()


def on(event_type, fn=None, **filters):
    """Register `fn(event)` for `event_type` ("key", "touch", "notification", "toast", "a11y", "cloud", "float").

    Keyword filters match event fields, e.g. `on("key", fn, key_code=24, action="down")`.
    Returns a token for `off(token)`. Without `fn`, returns a decorator.
    """
    if event_type not in TYPES:
        raise ValueError("event_type must be one of %s" % ", ".join(TYPES))
    if fn is None:
        def deco(f):
            on(event_type, f, **filters)
            return f
        return deco
    with _reg.lock:
        _reg.seq += 1
        token = _reg.seq
        _reg.handlers.append((token, event_type, _matcher(filters), fn))
    _sync()
    return token


def off(token=None, event_type=None):
    """Remove one handler (by token or function), all handlers of `event_type`, or everything."""
    with _reg.lock:
        if token is not None:
            _reg.handlers = [h for h in _reg.handlers if h[0] != token and h[3] is not token]
        elif event_type is not None:
            _reg.handlers = [h for h in _reg.handlers if h[1] != event_type]
        else:
            _reg.handlers = []
    _sync()


def wait(event_type, timeout=None, **filters):
    """Block until the next matching event and return it, or None after `timeout` seconds."""
    if event_type not in TYPES:
        raise ValueError("event_type must be one of %s" % ", ".join(TYPES))
    box = []
    done = threading.Event()
    entry = (event_type, _matcher(filters), box, done)
    with _reg.lock:
        _reg.waiters.append(entry)
    _sync()
    done.wait(timeout)
    with _reg.lock:
        if entry in _reg.waiters:
            _reg.waiters.remove(entry)
    _sync()
    return box[0] if box else None


def loop():
    """Keep the script alive while handlers are registered (returns when all are removed)."""
    while True:
        with _reg.lock:
            if not _reg.handlers:
                return
        time.sleep(0.5)


def status():
    """{"types": [...], "attached": bool, "notification_listener": bool} from the main process."""
    raw = bridge.control("events_status")
    return json.loads(raw) if raw else {}


# ---------------------------------------------------------------- decorators

def on_key(key_code=None, action=None):
    """@on_key(24) / @on_key(action="down"): physical keys (e.key_code, e.action 'down'/'up')."""
    return on(KEY, key_code=key_code, action=action)


def on_touch(action=None):
    """@on_touch("click"): view click / long_click / scroll with e.x, e.y (center of the view)."""
    return on(TOUCH, action=action)


def on_notification(package=None):
    """@on_notification("com.tencent.mm"): e.package, e.title, e.text, e.time, e.send()."""
    return on(NOTIFICATION, package=package)


def on_toast(package=None):
    """@on_toast(): e.package, e.text."""
    return on(TOAST, package=package)


def on_accessibility(mask=0, package=None):
    """@on_accessibility(): raw events (e.event_type, e.event_name, e.package, e.class, e.text).

    `mask` is an AccessibilityEvent type mask; 0 = everything except WINDOW_CONTENT_CHANGED.
    """
    with _reg.lock:
        _reg.a11y_mask = int(mask)
    return on(ACCESSIBILITY, package=package)
