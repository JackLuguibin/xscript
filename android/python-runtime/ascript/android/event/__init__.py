"""Key / touch / notification event listeners (AScript `ascript.android.event`).

    @KeyEvent.on(key_code=KeyEvent.VOLUME_UP)
    def on_vol(event):
        if event.action == "down": ...

    @NotificationEvent.on(package="com.tencent.mm")
    def on_wx(event):
        print(event.title, event.text)
        event.send()

Handlers run on a background thread; keep the script alive with a loop. Backed by
`xscript.android.event`.
"""

from xscript.android import event as _ev


_tokens = {}  # listener class name -> [token]


class _Listener(object):
    _type = None

    @classmethod
    def _register(cls, fn, **filters):
        _tokens.setdefault(cls.__name__, []).append(_ev.on(cls._type, fn, **filters))
        return fn

    @classmethod
    def stop(cls):
        """Remove every handler registered through this class."""
        for t in _tokens.pop(cls.__name__, []):
            _ev.off(t)


class KeyEvent(_Listener):
    """Physical keys. Needs 无障碍. Fields: key_code, action ('down' / 'up')."""

    _type = _ev.KEY
    VOLUME_UP = 24
    VOLUME_DOWN = 25
    BACK = 4
    HOME = 3
    MENU = 82
    POWER = 26

    @classmethod
    def on(cls, key_code=None):
        def deco(fn):
            return cls._register(fn, key_code=key_code)
        return deco


class TouchEvent(_Listener):
    """View interactions seen by accessibility. Fields: action ('click' / 'long_click' / 'scroll'), x, y."""

    _type = _ev.TOUCH

    @classmethod
    def on(cls, action=None):
        def deco(fn):
            return cls._register(fn, action=action)
        return deco


class NotificationEvent(_Listener):
    """Notifications. Fields: package, title, text, time, raw (None), send()."""

    _type = _ev.NOTIFICATION

    @classmethod
    def on(cls, package=None):
        def deco(fn):
            def wrapper(e):
                # AScript exposes the StatusBarNotification as `raw`; XScript sends plain data.
                if not hasattr(e, "raw"):
                    e.raw = None
                return fn(e)
            wrapper.__wrapped__ = fn
            cls._register(wrapper, package=package)
            return fn
        return deco
