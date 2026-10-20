"""ascript.android.ui (and xscript.android.ui under it) against a fake device that records every UI op."""

import contextlib
import io
import json
import os
import tempfile
import threading
import time
import unittest

import numpy as np

from fake_device import FakeDevice, make_screen, patch_bridge


class UiCase(unittest.TestCase):
    def setUp(self):
        self.dev = FakeDevice(make_screen())
        self.dev.ui_replies["win_create"] = "w7"
        self.undo = patch_bridge(self.dev)
        self.windows = []

    def tearDown(self):
        for w in self.windows:
            w.close()
        from xscript.android import event, ui as xu

        xu._float_menus.clear()
        event.off()
        self.undo()

    def push(self, key, value=None):
        self.dev.events.put({"key": key, "value": value})

    def wait_for(self, cond, timeout=2.0):
        end = time.time() + timeout
        while time.time() < end:
            if cond():
                return True
            time.sleep(0.01)
        return cond()


class DialogTest(UiCase):
    def test_toast_keeps_duration_and_drops_layout_args(self):
        from ascript.android.ui import Dialog

        Dialog.toast("hi", 1500, gravity=48, x=10, y=0.5, bg_color="#000", color="#fff", font_size=20)
        self.assertEqual(self.dev.ops("toast"), [{"msg": "hi", "dur": 1500}])

    def test_alert_confirm_prompt_select(self):
        from ascript.android.ui import Dialog

        self.dev.ui_replies.update(alert='{"ok": true}', confirm='{"ok": true, "value": true}',
                                   prompt='{"ok": true, "value": "abc"}', select='{"ok": true, "value": "B"}')
        self.assertTrue(Dialog.alert("A", submit="好"))
        self.assertEqual(self.dev.ops("alert")[0], {"msg": "A", "title": "", "submit": "好"})
        self.assertTrue(Dialog.confirm("sure?", "T", "是", "否"))
        self.assertEqual(self.dev.ops("confirm")[0], {"msg": "sure?", "title": "T", "submit": "是", "cancel": "否"})
        self.assertEqual(Dialog.prompt("name", value="x", hint="h"), "abc")
        self.assertEqual(self.dev.ops("prompt")[0]["value"], "x")
        self.assertEqual(self.dev.ops("prompt")[0]["hint"], "h")
        self.assertEqual(Dialog.select([1, "B"], "pick", "T", submit="ok", cancel="no"), "B")
        self.assertEqual(self.dev.ops("select")[0], {"items": ["1", "B"], "msg": "pick", "title": "T", "cancel": "no"})

    def test_cancelled_dialogs(self):
        from ascript.android.ui import Dialog

        self.dev.ui_replies.update(confirm='{"ok": false}', prompt='{"ok": false, "value": "x"}', select="")
        self.assertFalse(Dialog.confirm("?"))
        self.assertIsNone(Dialog.prompt())
        self.assertIsNone(Dialog.select(["a"]))

    def test_missing_overlay_permission_raises(self):
        from ascript.android.ui import Dialog

        self.dev.ui_replies["alert"] = '{"ok": false, "error": "overlay_permission"}'
        with self.assertRaisesRegex(RuntimeError, "悬浮窗"):
            Dialog.alert("x")

    def test_can_overlay(self):
        from xscript.android import ui as xu

        self.dev.ui_replies["can_overlay"] = "true"
        self.assertTrue(xu.can_overlay())
        self.dev.ui_replies["can_overlay"] = "false"
        self.assertFalse(xu.can_overlay())


class WebWindowTest(UiCase):
    def make(self, html="<p>x</p>", **kw):
        from ascript.android.ui import WebWindow

        w = WebWindow(html, **kw)
        self.windows.append(w)
        return w

    def test_options_set_before_show_go_into_create(self):
        w = self.make(id=3)
        w.size("80vw", "30vh")
        w.background("#112233")
        w.drag(1)
        w.dim_amount(0.3)
        w.gravity(17, 5, 6)
        self.assertEqual(self.dev.ops("win_create"), [])  # nothing reaches the device before show()
        w.show()
        create = self.dev.ops("win_create")[0]
        self.assertEqual(create, {"html": "<p>x</p>", "id": "as3", "width": "80vw", "height": "30vh",
                                  "background": "#112233", "drag": True, "dim": 0.3, "gravity": 17, "x": 5, "y": 6})
        self.assertEqual(self.dev.ops("win_show"), [{"id": "w7"}])

    def test_options_after_show_become_updates(self):
        w = self.make()
        w.show()
        w.width("50vw")
        w.height(None)  # AScript ignores empty sizes
        w.x(10.9)
        w.y(20)
        self.assertEqual(self.dev.ops("win_update"), [{"width": "50vw", "id": "w7"}, {"x": 10, "id": "w7"},
                                                      {"y": 20, "id": "w7"}])
        self.assertIsNone(w.mode(1))
        self.assertIsNone(w.type(2))

    def test_on_handlers_tunnel_fallback_and_internal_keys(self):
        got = []
        w = self.make()

        @w.on("go")
        def go(v):
            got.append(("go", v))

        @w.tunner()
        def tunnel(k, v):
            got.append(("tunnel", k, v))

        w.show()
        self.push("__loaded")
        self.push("go", "1")
        self.push("other", {"a": 1})
        self.assertTrue(self.wait_for(lambda: len(got) == 2))
        self.assertEqual(got, [("go", "1"), ("tunnel", "other", {"a": 1})])

    def test_tunner_direct_and_constructor_tunnel(self):
        seen = []
        w = self.make(tunnel=lambda k, v: seen.append(k))
        fn = lambda k, v: seen.append("direct:" + k)  # noqa: E731
        self.assertIs(w.tunner(fn), fn)
        w.show()
        self.push("k")
        self.assertTrue(self.wait_for(lambda: seen == ["direct:k"]))

    def test_handler_errors_do_not_kill_the_pump(self):
        got = []
        w = self.make()
        w.on("bad")(lambda v: 1 / 0)
        w.on("good")(got.append)
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            w.show()
            self.push("bad")
            self.push("good", 2)
            self.assertTrue(self.wait_for(lambda: got == [2]))
        self.assertIn("ZeroDivisionError", err.getvalue())

    def test_show_wait_returns_when_page_closes(self):
        w = self.make()
        done = threading.Event()
        threading.Thread(target=lambda: (w.show(wait=True), done.set()), daemon=True).start()
        self.assertFalse(done.wait(0.2))
        self.push("__close")
        self.assertTrue(done.wait(2))
        self.assertTrue(w._win.closed)
        w.close()  # already closed by the page: no second win_close
        self.assertEqual(self.dev.ops("win_close"), [])

    def test_close_sends_win_close_once(self):
        w = self.make()
        w.close()  # never shown: nothing to close
        w.show()
        w.close()
        w.close()
        self.assertEqual(self.dev.ops("win_close"), [{"id": "w7"}])

    def test_js_round_trip_and_get_html(self):
        w = self.make()

        def answer(args):
            if args.get("token"):
                self.push("__js:" + args["token"], json.dumps("<html>ok</html>"))
            return ""
        self.dev.ui_replies["win_js"] = answer
        self.assertEqual(w.get_html(), "<html>ok</html>")
        self.assertEqual(w.dump(), "<html>ok</html>")
        w.call("go()")
        self.assertEqual(self.dev.ops("win_js")[-1], {"id": "w7", "js": "go()", "token": ""})
        res = []
        w.call("1+1", res.append)
        self.assertTrue(self.wait_for(lambda: res == [json.dumps("<html>ok</html>")]))

    def test_js_timeout_returns_none(self):
        from xscript.android import ui as xu

        win = xu.Window("<p/>")
        self.windows.append(win)
        self.assertIsNone(win.js("slow()", timeout=0.05))
        self.assertEqual(win._js_events, {})

    def test_navigation(self):
        w = self.make()
        self.dev.ui_replies["win_nav"] = lambda a: "true" if a["dir"] == "back" else "false"
        self.assertTrue(w.go_back())
        self.assertFalse(w.go_forward())

    def test_loger_defaults(self):
        from ascript.android.ui import Loger

        lg = Loger()
        self.windows.append(lg)
        lg.show()
        c = self.dev.ops("win_create")[0]
        self.assertEqual((c["id"], c["drag"], c["background"], c["width"]), ("as11", True, "#88000000", "50vw"))
        self.assertIn("id='log'", c["html"])

    def test_xscript_window_layout_helpers(self):
        from xscript.android import ui as xu

        win = xu.Window("<p/>", width=100, height=50, focusable=True)
        self.windows.append(win)
        self.assertEqual(self.dev.ops("win_create")[0], {"html": "<p/>", "width": 100, "height": 50, "focusable": True})
        win.size(height=60).position(gravity=3, x=1.5).draggable(False).background(0).dim().focusable(False)
        self.assertEqual([{k: v for k, v in u.items() if k != "id"} for u in self.dev.ops("win_update")],
                         [{"height": 60}, {"gravity": 3, "x": 1}, {"drag": False}, {"background": "0"},
                          {"dim": 0.5}, {"focusable": False}])
        self.assertFalse(win.wait(0.01))


class CanvasTest(UiCase):
    def test_every_shape_maps_to_canvas_draw(self):
        from ascript.android.ui import Canvas

        c = Canvas(offset_y=10)
        c.show(wait=False)
        c.draw_rect(1, 2, 3, 4, label="L", id="r")
        c.draw_circle(5, 6, 7)
        c.draw_line(1, 1, 2, 2)
        c.draw_text(3, 3, 99)
        c.draw_point(4, 4)
        c.draw_cross(5, 5)
        c.draw_arrow(0, 0, 9, 9)
        c.draw_region(0, 0, 5, 5, label="zone")
        c.draw_polygon([(0, 0), (5, 0), (5, 5)], close=False)
        c.draw_oval(0, 0, 4, 2, duration=0)
        draws = self.dev.ops("canvas_draw")
        self.assertEqual([d["shape"] for d in draws],
                         ["rect", "circle", "line", "text", "point", "cross", "arrow", "region", "polygon", "oval"])
        self.assertEqual(draws[0], {"shape": "rect", "id": "r", "duration": 3000, "x1": 1, "y1": 2, "x2": 3, "y2": 4,
                                    "color": "#ff00ff", "stroke_width": 2, "label": "L", "font_size": 12})
        self.assertEqual(draws[3]["text"], "99")
        self.assertEqual(draws[7]["fill"], "rgba(255,0,255,0.15)")
        self.assertEqual(draws[8]["points"], [[0, 0], [5, 0], [5, 5]])
        self.assertIs(draws[8]["close"], False)
        self.assertEqual(draws[9]["duration"], 0)
        ids = [d["id"] for d in draws[1:]]
        self.assertEqual(len(set(ids)), len(ids))  # auto ids never collide
        self.assertEqual(self.dev.ops("canvas_show"), [{}])

    def test_remove_clear_close(self):
        from ascript.android.ui import Canvas

        c = Canvas()
        i = c.draw_point(1, 1)
        c.remove(i)
        c.clear()
        c.close()
        self.assertEqual(self.dev.ops("canvas_remove"), [{"item": i}])
        self.assertEqual([op for op, _ in self.dev.ui_calls], ["canvas_draw", "canvas_remove", "canvas_clear",
                                                               "canvas_close"])


class FloatAndImageTest(UiCase):
    def test_float_show_hide(self):
        from ascript.android.ui import FloatWindow

        FloatWindow.show(0.2, -1, 0.5)
        FloatWindow.hide()
        op, arg = self.dev.controls[0]
        self.assertEqual(op, "float_show")
        self.assertEqual(json.loads(arg), {"dim": 0.5, "x": 0.2, "y": -1.0})
        self.assertEqual(self.dev.controls[1], ("float_hide", ""))

    def test_float_show_without_position_keeps_user_drag(self):
        from xscript.android import ui as xu

        xu.float_show()
        self.assertEqual(json.loads(self.dev.controls[0][1]), {"dim": 1.0})

    def test_add_menu_dispatches_and_replaces(self):
        from ascript.android.ui import FloatWindow
        from xscript.android import event

        calls = []
        FloatWindow.add_menu("m1", "/sdcard/i.png", lambda: calls.append("old"))
        FloatWindow.add_menu("m1", "/sdcard/i.png", lambda mid: calls.append(mid), remove_system=True)
        FloatWindow.add_menu("m2", 12345, lambda: calls.append("m2"))  # non-path icon: warned, id shown
        adds = [json.loads(a) for op, a in self.dev.controls if op == "float_menu_add"]
        self.assertEqual(adds[1], {"id": "m1", "icon": "/sdcard/i.png", "remove_system": True})
        self.assertEqual(adds[2]["icon"], "")
        event.dispatch({"type": "float", "menu": "m1"})
        event.dispatch({"type": "float", "menu": "m2"})
        self.assertTrue(self.wait_for(lambda: sorted(calls) == ["m1", "m2"]))

    def test_add_menu_rejects_non_callable(self):
        from xscript.android import ui as xu

        with self.assertRaises(TypeError):
            xu.float_add_menu("x", None, "not callable")

    def test_image_window_path_and_array(self):
        from ascript.android.ui import ImageWindow

        ImageWindow.show("/sdcard/a.png")
        ImageWindow.show(np.zeros((4, 4, 3), np.uint8))
        shows = self.dev.ops("image_show")
        self.assertEqual(shows[0], {"path": "/sdcard/a.png"})
        tmp = shows[1]["path"]
        self.assertTrue(tmp.startswith(tempfile.gettempdir()) and tmp.endswith(".png"))
        self.assertTrue(os.path.isfile(tmp))
        os.remove(tmp)


if __name__ == "__main__":
    unittest.main()
