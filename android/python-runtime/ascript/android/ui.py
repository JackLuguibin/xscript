"""ascript.android.ui on XScript: WebWindow, Dialog, FloatWindow, ImageWindow, Canvas."""

import json
import os
import tempfile
import threading
import time

from ascript._compat import warn_once
from xscript.android import ui as _xu


class WebWindow:
    """AScript HTML window. Pages call `window.airscript.call(key, value)`."""

    def __init__(self, html, tunnel=None, id=None):
        self.id = id
        self._user_tunnel = tunnel
        self._on_handlers = {}
        self._opts = {}
        self._html = html
        self._win = None
        self.res = None

    def _ensure(self):
        if self._win is None:
            opts = dict(self._opts)
            if self.id:
                opts["id"] = "as%s" % self.id
            self._win = _xu.Window(self._html, **opts)
            self._win.listen(self._dispatch)
        return self._win

    def _dispatch(self, key, value):
        handler = self._on_handlers.get(key)
        if handler:
            handler(value)
        elif self._user_tunnel:
            self._user_tunnel(key, value)

    def _set(self, **kw):
        self._opts.update(kw)
        if self._win is not None:
            self._win.update(**kw)

    def mode(self, mode=0):
        return None

    def type(self, ftype=0):
        return None

    def tunner(self, fun=None):
        if fun is not None:
            self._user_tunnel = fun
            return fun

        def decorator(func):
            self._user_tunnel = func
            return func
        return decorator

    def on(self, key):
        def decorator(func):
            self._on_handlers[key] = func
            return func
        return decorator

    def size(self, width=None, height=None):
        kw = {}
        if width:
            kw["width"] = width
        if height:
            kw["height"] = height
        self._set(**kw)

    def width(self, width):
        if width:
            self._set(width=width)

    def height(self, height):
        if height:
            self._set(height=height)

    def background(self, color):
        self._set(background=color)

    def drag(self, is_drag=False):
        self._set(drag=bool(is_drag))

    def dim_amount(self, dim=0.5):
        self._set(dim=float(dim))

    def gravity(self, gravity=None, offset_x=None, offset_y=None):
        kw = {}
        if gravity:
            kw["gravity"] = int(gravity)
        if offset_x:
            kw["x"] = int(offset_x)
        if offset_y:
            kw["y"] = int(offset_y)
        self._set(**kw)

    def x(self, offset_x):
        self._set(x=int(offset_x))

    def y(self, offset_y):
        self._set(y=int(offset_y))

    def show(self, wait=False):
        win = self._ensure()
        win.show()
        if wait:
            win.wait()

    def close(self):
        if self._win is not None:
            self._win.close()

    def go_back(self):
        return self._ensure().back()

    def go_forward(self):
        return self._ensure().forward()

    def call(self, js, res_callback=None):
        win = self._ensure()
        if res_callback is None:
            win.run_js(js)
            return

        def worker():
            res_callback(win.js(js))
        threading.Thread(target=worker, daemon=True).start()

    def get_html(self):
        raw = self._ensure().js("document.documentElement.outerHTML")
        return json.loads(raw) if raw else None

    def dump(self):
        return self.get_html()


class Dialog:
    @staticmethod
    def toast(msg, dur=3000, gravity=1 | 16, x=0, y=0.2, bg_color=None, color=None, font_size=0):
        _xu.toast(msg, dur)

    @staticmethod
    def alert(msg, submit="确认"):
        return _xu.alert(msg, submit=submit)

    @staticmethod
    def confirm(msg, title=None, submit="确认", cancel="取消"):
        return _xu.confirm(msg, title, submit, cancel)

    @staticmethod
    def prompt(msg="请输入信息", title=None, value=None, hint=None, submit="确认", cancel="取消"):
        return _xu.prompt(msg, title, value, hint, submit, cancel)

    @staticmethod
    def select(items, msg="请选择", title=None, submit="确认", cancel="取消"):
        return _xu.select(items, msg, title, cancel)


class Loger(WebWindow):
    def __init__(self, html=None):
        super().__init__(html or "<pre id='log' style='color:#fff;font:12px monospace'></pre>", id=11)
        self.drag(True)
        self.background("#88000000")
        self.size("50vw", "50vw")


class FloatWindow:
    @staticmethod
    def hide():
        _xu.float_hide()

    @staticmethod
    def show(x=-1, y=-1, dim=1):
        _xu.float_show(x, y, dim)

    @staticmethod
    def add_menu(menu_id, menu_ico, menu_click_listener, remove_system=False):
        warn_once("float_menu", "FloatWindow.add_menu is not supported by XScript")


class ImageWindow:
    @staticmethod
    def show(file_or_bitmap_or_ndarray):
        src = file_or_bitmap_or_ndarray
        if isinstance(src, str):
            _xu.show_image(src)
            return
        from ascript.android import screen

        path = os.path.join(tempfile.gettempdir(), "xscript_preview_%d.png" % int(time.time() * 1000))
        screen.bitmap_to_file(path, src)
        _xu.show_image(path)


class Canvas:
    """AScript Canvas: draw_* methods, duration=0 keeps the item until removed."""

    def __init__(self, offset_y=None):
        self._c = _xu.Canvas()

    def show(self, wait=True):
        self._c.show()

    def draw_rect(self, x1, y1, x2, y2, color="#ff00ff", stroke_width=2, duration=3000, label=None, font_size=12, id=None):
        return self._c.rect(x1, y1, x2, y2, color, stroke_width, duration, label, font_size, id)

    def draw_circle(self, x, y, radius, color="#00ff00", stroke_width=2, duration=3000, label=None, font_size=12, id=None):
        return self._c.circle(x, y, radius, color, stroke_width, duration, label, font_size, id)

    def draw_line(self, x1, y1, x2, y2, color="#65db79", stroke_width=1, duration=3000, id=None):
        return self._c.line(x1, y1, x2, y2, color, stroke_width, duration, id)

    def draw_text(self, x, y, text, color="#ffffff", font_size=14, duration=3000, id=None):
        return self._c.text(x, y, text, color, font_size, duration, id)

    def draw_point(self, x, y, color="#ff0000", radius=5, duration=3000, id=None):
        return self._c.point(x, y, color, radius, duration, id)

    def draw_cross(self, x, y, size=30, color="#ff0000", stroke_width=2, duration=3000, label=None, font_size=12, id=None):
        return self._c.cross(x, y, size, color, stroke_width, duration, label, font_size, id)

    def draw_arrow(self, x1, y1, x2, y2, color="#ffaa00", stroke_width=2, duration=3000, id=None):
        return self._c.arrow(x1, y1, x2, y2, color, stroke_width, duration, id)

    def draw_region(self, x1, y1, x2, y2, color="#ff00ff", fill="rgba(255,0,255,0.15)", stroke_width=1,
                    duration=3000, label=None, font_size=12, id=None):
        return self._c.region(x1, y1, x2, y2, color, fill, stroke_width, duration, label, font_size, id)

    def draw_polygon(self, points, color="#00ffff", stroke_width=2, duration=3000, close=True, id=None):
        return self._c.polygon(points, color, stroke_width, duration, close, id)

    def draw_oval(self, x1, y1, x2, y2, color="#00ff00", stroke_width=2, duration=3000, id=None):
        return self._c.oval(x1, y1, x2, y2, color, stroke_width, duration, id)

    def remove(self, id):
        self._c.remove(id)

    def clear(self):
        self._c.clear()

    def close(self):
        self._c.close()
