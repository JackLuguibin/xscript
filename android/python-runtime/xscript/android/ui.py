"""Overlay UI for scripts: toast, dialogs, HTML windows and a drawing canvas.

Dialogs and windows need the 悬浮窗 (overlay) permission.
"""

import json
import threading
import time

from xscript.runtime.bridge import bridge


def _ui(op, args=None):
    return bridge.ui(op, args or {})


def can_overlay():
    return _ui("can_overlay") == "true"


def toast(msg, dur=2000):
    _ui("toast", {"msg": str(msg), "dur": int(dur)})


def _dialog(kind, args):
    raw = _ui(kind, args)
    res = json.loads(raw) if raw else {"ok": False}
    if res.get("error") == "overlay_permission":
        raise RuntimeError("悬浮窗权限未授权，无法显示对话框")
    return res


def alert(msg, title=None, submit="确认"):
    _dialog("alert", {"msg": str(msg), "title": title or "", "submit": submit})
    return True


def confirm(msg, title=None, submit="确认", cancel="取消"):
    res = _dialog("confirm", {"msg": str(msg), "title": title or "", "submit": submit, "cancel": cancel})
    return bool(res.get("ok") and res.get("value"))


def prompt(msg="请输入信息", title=None, value=None, hint=None, submit="确认", cancel="取消"):
    res = _dialog("prompt", {
        "msg": str(msg), "title": title or "", "value": value or "", "hint": hint or "",
        "submit": submit, "cancel": cancel,
    })
    return res.get("value") if res.get("ok") else None


def select(items, msg="请选择", title=None, cancel="取消"):
    res = _dialog("select", {"items": [str(i) for i in items], "msg": msg, "title": title or "", "cancel": cancel})
    return res.get("value") if res.get("ok") else None


class Window(object):
    """HTML overlay window. JS talks back with `window.xscript.call(key, value)`
    (alias `window.airscript.call`) and `window.xscript.close()`.

        win = Window("<button onclick=\\"xscript.call('go','1')\\">Go</button>", width="80vw", height="30vh")

        @win.on("go")
        def go(value):
            print("clicked", value)

        win.show(wait=True)   # blocks until closed
    """

    def __init__(self, html, width=None, height=None, **opts):
        self._handlers = {}
        self._fallback = None
        self._closed = threading.Event()
        self._js_results = {}
        self._js_events = {}
        self._pump = None
        args = {"html": html}
        if width is not None:
            args["width"] = width
        if height is not None:
            args["height"] = height
        args.update(opts)
        self.id = _ui("win_create", args)

    # ---- events
    def on(self, key):
        def deco(fn):
            self._handlers[key] = fn
            self._start_pump()
            return fn
        return deco

    def listen(self, fn):
        """Catch-all handler fn(key, value)."""
        self._fallback = fn
        self._start_pump()
        return fn

    def _start_pump(self):
        if self._pump is not None:
            return
        self._pump = threading.Thread(target=self._loop, name="xscript-ui-%s" % self.id, daemon=True)
        self._pump.start()

    def _loop(self):
        while not self._closed.is_set():
            raw = bridge.ui_poll(self.id, 500)
            if not raw:
                continue
            ev = json.loads(raw)
            self._dispatch(ev.get("key", ""), ev.get("value"))

    def _dispatch(self, key, value):
        if key == "__close":
            self._closed.set()
            return
        if key.startswith("__js:"):
            token = key[5:]
            self._js_results[token] = value
            e = self._js_events.get(token)
            if e:
                e.set()
            return
        if key == "__loaded":
            return
        handler = self._handlers.get(key)
        try:
            if handler is not None:
                handler(value)
            elif self._fallback is not None:
                self._fallback(key, value)
        except Exception:
            import traceback

            traceback.print_exc()

    # ---- layout
    def update(self, **opts):
        _ui("win_update", dict(opts, id=self.id))
        return self

    def size(self, width=None, height=None):
        opts = {}
        if width is not None:
            opts["width"] = width
        if height is not None:
            opts["height"] = height
        return self.update(**opts)

    def position(self, gravity=None, x=None, y=None):
        opts = {}
        if gravity is not None:
            opts["gravity"] = int(gravity)
        if x is not None:
            opts["x"] = int(x)
        if y is not None:
            opts["y"] = int(y)
        return self.update(**opts)

    def draggable(self, enabled=True):
        return self.update(drag=bool(enabled))

    def background(self, color):
        return self.update(background=str(color))

    def dim(self, amount=0.5):
        return self.update(dim=float(amount))

    def focusable(self, enabled=True):
        """Allow keyboard input into the page (steals focus from the app below)."""
        return self.update(focusable=bool(enabled))

    # ---- lifecycle
    def show(self, wait=False):
        self._start_pump()
        _ui("win_show", {"id": self.id})
        if wait:
            self.wait()
        return self

    def wait(self, timeout=None):
        return self._closed.wait(timeout)

    @property
    def closed(self):
        return self._closed.is_set()

    def close(self):
        if not self._closed.is_set():
            _ui("win_close", {"id": self.id})
        self._closed.set()

    def js(self, code, timeout=5):
        """Evaluate JS in the page; returns the JSON-encoded result string (or None on timeout)."""
        token = "%d" % (time.time() * 1e6)
        ev = threading.Event()
        self._js_events[token] = ev
        self._start_pump()
        _ui("win_js", {"id": self.id, "js": code, "token": token})
        ev.wait(timeout)
        self._js_events.pop(token, None)
        return self._js_results.pop(token, None)

    def run_js(self, code):
        """Fire-and-forget JS."""
        _ui("win_js", {"id": self.id, "js": code, "token": ""})

    def back(self):
        return _ui("win_nav", {"id": self.id, "dir": "back"}) == "true"

    def forward(self):
        return _ui("win_nav", {"id": self.id, "dir": "forward"}) == "true"


class Canvas(object):
    """Full-screen, touch-through overlay for drawing debug marks in screen coordinates."""

    _seq = 0

    def __init__(self):
        self._shown = False

    def show(self):
        _ui("canvas_show")
        self._shown = True
        return self

    def _draw(self, shape, id=None, duration=3000, **kw):
        if id is None:
            Canvas._seq += 1
            id = "c%d" % Canvas._seq
        kw.update({"shape": shape, "id": str(id), "duration": int(duration)})
        _ui("canvas_draw", kw)
        return id

    def rect(self, x1, y1, x2, y2, color="#ff00ff", stroke_width=2, duration=3000, label=None, font_size=12, id=None):
        return self._draw("rect", id, duration, x1=x1, y1=y1, x2=x2, y2=y2, color=color,
                          stroke_width=stroke_width, label=label or "", font_size=font_size)

    def region(self, x1, y1, x2, y2, color="#ff00ff", fill="rgba(255,0,255,0.15)", stroke_width=1, duration=3000,
               label=None, font_size=12, id=None):
        return self._draw("region", id, duration, x1=x1, y1=y1, x2=x2, y2=y2, color=color, fill=fill,
                          stroke_width=stroke_width, label=label or "", font_size=font_size)

    def circle(self, x, y, radius, color="#00ff00", stroke_width=2, duration=3000, label=None, font_size=12, id=None):
        return self._draw("circle", id, duration, x=x, y=y, radius=radius, color=color,
                          stroke_width=stroke_width, label=label or "", font_size=font_size)

    def oval(self, x1, y1, x2, y2, color="#00ff00", stroke_width=2, duration=3000, id=None):
        return self._draw("oval", id, duration, x1=x1, y1=y1, x2=x2, y2=y2, color=color, stroke_width=stroke_width)

    def line(self, x1, y1, x2, y2, color="#65db79", stroke_width=1, duration=3000, id=None):
        return self._draw("line", id, duration, x1=x1, y1=y1, x2=x2, y2=y2, color=color, stroke_width=stroke_width)

    def arrow(self, x1, y1, x2, y2, color="#ffaa00", stroke_width=2, duration=3000, id=None):
        return self._draw("arrow", id, duration, x1=x1, y1=y1, x2=x2, y2=y2, color=color, stroke_width=stroke_width)

    def text(self, x, y, text, color="#ffffff", font_size=14, duration=3000, id=None):
        return self._draw("text", id, duration, x=x, y=y, text=str(text), color=color, font_size=font_size)

    def point(self, x, y, color="#ff0000", radius=5, duration=3000, id=None):
        return self._draw("point", id, duration, x=x, y=y, color=color, radius=radius)

    def cross(self, x, y, size=30, color="#ff0000", stroke_width=2, duration=3000, label=None, font_size=12, id=None):
        return self._draw("cross", id, duration, x=x, y=y, size=size, color=color,
                          stroke_width=stroke_width, label=label or "", font_size=font_size)

    def polygon(self, points, color="#00ffff", stroke_width=2, duration=3000, close=True, id=None):
        return self._draw("polygon", id, duration, points=[[p[0], p[1]] for p in points], color=color,
                          stroke_width=stroke_width, close=bool(close))

    def remove(self, id):
        _ui("canvas_remove", {"item": str(id)})

    def clear(self):
        _ui("canvas_clear")

    def close(self):
        _ui("canvas_close")
        self._shown = False


def show_image(path):
    """Preview an image file in an overlay (tap to close)."""
    _ui("image_show", {"path": str(path)})


def float_show(x=None, y=None, dim=1.0):
    """Show the floating window (悬浮窗) for this run, even while the app is on screen.

    Same x / y / dim as AScript ``FloatWindow.show``: a positive number is a pixel position, a decimal
    below 1 is a share of the screen (0.2 = 20%), -1 / 0 mean the far / near edge (right-bottom / left-top).
    XScript always docks the window to the nearer side edge. ``None`` keeps the position the user dragged it to.
    ``dim`` is the opacity, 0-1.
    """
    import json
    arg = {"dim": float(dim)}
    if x is not None:
        arg["x"] = float(x)
    if y is not None:
        arg["y"] = float(y)
    bridge.control("float_show", json.dumps(arg))


def float_hide():
    bridge.control("float_hide", "")


_float_menus = {}


def float_add_menu(menu_id, icon, callback, remove_system=False):
    """Add a round button to the floating window's panel (AScript ``FloatWindow.add_menu``).

    ``icon`` is an image file path (``R.img(...)``); without a readable image the button shows the first
    letters of ``menu_id``. ``callback`` runs on its own thread when the button is tapped, with no argument
    (or with ``menu_id`` when it takes one). ``remove_system=True`` hides the built-in 运行/日志/打开/隐藏
    buttons while custom ones exist. Adding the same ``menu_id`` again replaces the earlier button. The buttons
    last until the script ends. The window itself still needs ``float_show()`` or the 悬浮窗显示 setting.
    """
    import inspect
    import json
    import threading
    from xscript.android import event

    menu_id = str(menu_id)
    if not callable(callback):
        raise TypeError("callback must be callable")
    try:
        wants_id = len([p for p in inspect.signature(callback).parameters.values()
                        if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD)]) >= 1
    except (TypeError, ValueError):
        wants_id = False

    def run(_ev):
        threading.Thread(target=callback, args=(menu_id,) if wants_id else (), name="xscript-float-menu", daemon=True).start()

    old = _float_menus.pop(menu_id, None)
    if old is not None:
        event.off(old)
    _float_menus[menu_id] = event.on(event.FLOAT, run, menu=menu_id)
    icon = icon if isinstance(icon, str) else ""
    bridge.control("float_menu_add", json.dumps({"id": menu_id, "icon": icon, "remove_system": bool(remove_system)}))
