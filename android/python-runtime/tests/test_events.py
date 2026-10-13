"""Event listeners, lifecycle config, schedules: Python side against a fake bridge."""

import json
import threading
import unittest

from xscript.runtime import bridge as bridge_mod


class FakeBridge(bridge_mod._MissingJava):
    def __init__(self):
        self.calls = []
        self.subscriptions = []
        self.events = []
        self.cond = threading.Condition()
        self.schedules = []

    def control(self, op, arg=""):
        if isinstance(arg, dict):
            arg = json.dumps(arg)
        self.calls.append((op, arg))
        if op == "events_subscribe":
            self.subscriptions.append(json.loads(arg))
            return json.dumps({"types": json.loads(arg)["types"], "attached": True})
        if op == "notification_send":
            return "true" if arg == "k1" else "false"
        if op == "config_set":
            a = json.loads(arg)
            return json.dumps(dict(a, boot_project=a["project"] if a.get("auto_run") else ""))
        if op == "config_get":
            return json.dumps({"project": arg, "auto_run": False, "stop_re_run": False, "boot_project": ""})
        if op == "schedule_add":
            a = json.loads(arg)
            if a.get("kind") == "daily" and a.get("time") == "25:00":
                return json.dumps({"error": "time must be HH:mm"})
            a["id"] = "s%d" % (len(self.schedules) + 1)
            self.schedules.append(a)
            return json.dumps(a)
        if op == "schedule_list":
            return json.dumps([s for s in self.schedules if not arg or s["project"] == arg])
        if op == "schedule_remove":
            before = len(self.schedules)
            self.schedules = [s for s in self.schedules if s["id"] != arg]
            return "true" if len(self.schedules) < before else "false"
        return ""

    def poll_event(self, timeout_ms):
        with self.cond:
            if not self.events:
                self.cond.wait(timeout_ms / 1000.0)
            return self.events.pop(0) if self.events else ""

    def push(self, **event):
        with self.cond:
            self.events.append(json.dumps(event))
            self.cond.notify_all()


class _Patched(unittest.TestCase):
    MODULES = ("xscript.android.event", "xscript.android.system")

    def setUp(self):
        self.fake = FakeBridge()
        self._patched = []
        for mod in self.MODULES:
            m = __import__(mod, fromlist=["bridge"])
            self._patched.append((m, m.bridge))
            m.bridge = self.fake
        from xscript.android import event

        event.off()
        event._reg.subscribed = (frozenset(), 0)
        self.fake.subscriptions.clear()

    def tearDown(self):
        from xscript.android import event

        event.off()
        for m, b in self._patched:
            m.bridge = b


class EventTest(_Patched):
    def test_subscribe_and_unsubscribe(self):
        from xscript.android import event

        token = event.on("key", lambda e: None, key_code=24)
        self.assertEqual(self.fake.subscriptions[-1]["types"], ["key"])
        event.on("toast", lambda e: None)
        self.assertEqual(self.fake.subscriptions[-1]["types"], ["key", "toast"])
        event.off(token)
        self.assertEqual(self.fake.subscriptions[-1]["types"], ["toast"])
        event.off()
        self.assertEqual(self.fake.subscriptions[-1]["types"], [])

    def test_dispatch_filters(self):
        from xscript.android import event

        got = []
        event.on("key", lambda e: got.append(("vol", e.key_code, e.action)), key_code=24)
        event.on("key", lambda e: got.append(("any", e["key_code"])))
        event.on("notification", lambda e: got.append(("wx", e.title)), package="com.tencent.mm")
        event.dispatch({"type": "key", "key_code": 25, "action": "down"})
        event.dispatch({"type": "key", "key_code": 24, "action": "up"})
        event.dispatch({"type": "notification", "package": "com.qq", "title": "no"})
        event.dispatch({"type": "notification", "package": "com.tencent.mm", "title": "hi"})
        self.assertEqual(got, [("any", 25), ("vol", 24, "up"), ("any", 24), ("wx", "hi")])

    def test_filter_list_and_callable(self):
        from xscript.android import event

        got = []
        event.on("key", lambda e: got.append(e.key_code), key_code=[24, 25], action=lambda a: a == "down")
        for code, action in ((24, "down"), (25, "up"), (26, "down"), (25, "down")):
            event.dispatch({"type": "key", "key_code": code, "action": action})
        self.assertEqual(got, [24, 25])

    def test_decorators(self):
        from xscript.android import event

        got = []

        @event.on_key(event.KEYCODE_VOLUME_DOWN)
        def vol(e):
            got.append(e.key_code)

        @event.on_touch("click")
        def click(e):
            got.append((e.x, e.y))

        self.assertTrue(callable(vol) and callable(click))
        event.dispatch({"type": "key", "key_code": 25, "action": "down"})
        event.dispatch({"type": "touch", "action": "scroll", "x": 1, "y": 2})
        event.dispatch({"type": "touch", "action": "click", "x": 3, "y": 4})
        self.assertEqual(got, [25, (3, 4)])

    def test_handler_error_does_not_stop_others(self):
        from xscript.android import event
        import io
        import sys

        got = []
        event.on("toast", lambda e: 1 / 0)
        event.on("toast", lambda e: got.append(e.text))
        err, sys.stderr = sys.stderr, io.StringIO()
        try:
            event.dispatch({"type": "toast", "text": "saved"})
        finally:
            sys.stderr = err
        self.assertEqual(got, ["saved"])

    def test_wait_through_pump(self):
        from xscript.android import event

        timer = threading.Timer(0.1, lambda: self.fake.push(type="toast", package="p", text="done"))
        timer.start()
        e = event.wait("toast", timeout=3)
        self.assertIsNotNone(e)
        self.assertEqual(e.text, "done")
        # the waiter unsubscribes once satisfied
        self.assertEqual(self.fake.subscriptions[-1]["types"], [])
        self.assertIsNone(event.wait("toast", timeout=0.05))

    def test_handler_through_pump(self):
        from xscript.android import event

        seen = threading.Event()
        event.on("notification", lambda e: seen.set(), package="a")
        self.fake.push(type="notification", package="b")
        self.fake.push(type="notification", package="a")
        self.assertTrue(seen.wait(3))

    def test_notification_send(self):
        from xscript.android import event

        self.assertTrue(event.Event({"type": "notification", "key": "k1"}).send())
        self.assertFalse(event.Event({"type": "notification", "key": "k2"}).send())
        self.assertFalse(event.Event({"type": "toast", "key": "k1"}).send())

    def test_a11y_mask_resubscribes(self):
        from xscript.android import event

        event.on_accessibility(mask=32)(lambda e: None)
        self.assertEqual(self.fake.subscriptions[-1], {"types": ["a11y"], "a11y_mask": 32})

    def test_bad_type(self):
        from xscript.android import event

        with self.assertRaises(ValueError):
            event.on("clicks", lambda e: None)


class AscriptEventTest(_Patched):
    def test_key_and_notification_classes(self):
        from ascript.android.event import KeyEvent, NotificationEvent
        from xscript.android import event

        got = []

        @KeyEvent.on(key_code=KeyEvent.VOLUME_UP)
        def on_vol(e):
            got.append(("key", e.key_code, e.action))

        @NotificationEvent.on(package="com.tencent.mm")
        def on_wx(e):
            got.append(("wx", e.title, e.raw))

        event.dispatch({"type": "key", "key_code": 24, "action": "down"})
        event.dispatch({"type": "notification", "package": "com.tencent.mm", "title": "hi"})
        KeyEvent.stop()
        event.dispatch({"type": "key", "key_code": 24, "action": "down"})
        self.assertEqual(got, [("key", 24, "down"), ("wx", "hi", None)])
        self.assertEqual(self.fake.subscriptions[-1]["types"], ["notification"])

    def test_selector_on_event(self):
        from ascript.android.node import Selector
        from xscript.android import event

        got = []
        Selector.on_event(lambda e: got.append((e.getEventType(), e.getPackageName(), e.getText())))
        event.dispatch({"type": "a11y", "event_type": 32, "package": "com.x", "text": ["a"]})
        Selector.on_event(None)
        event.dispatch({"type": "a11y", "event_type": 32, "package": "com.x", "text": ["b"]})
        self.assertEqual(got, [(32, "com.x", ["a"])])

    def test_notification_listen(self):
        from ascript.android.system import Notification
        from xscript.android import event

        got = []
        Notification.listen(lambda e: got.append(e.text))
        event.dispatch({"type": "notification", "package": "p", "text": "t"})
        Notification.listen(None)
        event.dispatch({"type": "notification", "package": "p", "text": "u"})
        self.assertEqual(got, ["t"])


class LifecycleTest(_Patched):
    def setUp(self):
        super().setUp()
        from xscript.runtime import runner

        runner._context["name"] = "demo"

    def tearDown(self):
        from xscript.runtime import runner

        runner._context["name"] = ""
        super().tearDown()

    def test_config(self):
        from xscript.android import system

        out = system.Config.set_auto_run(True)
        self.assertEqual(out["boot_project"], "demo")
        system.Config.set_stop_re_run(False, project="other")
        self.assertEqual(json.loads(self.fake.calls[-1][1]), {"project": "other", "stop_re_run": False})

    def test_ascript_config(self):
        from ascript.android.system import Config

        Config.set_stop_re_run(True)
        self.assertEqual(self.fake.calls[-1], ("config_set", json.dumps({"project": "demo", "stop_re_run": True})))

    def test_reboot(self):
        from xscript.android import system

        with self.assertRaises(SystemExit):
            system.reboot(1.5)
        self.assertEqual(self.fake.calls[-1], ("rerun_after_exit", "1500"))

    def test_ascript_reboot_ms(self):
        from ascript.android import system

        with self.assertRaises(SystemExit):
            system.reboot(2000)
        self.assertEqual(self.fake.calls[-1], ("rerun_after_exit", "2000"))

    def test_schedules(self):
        import datetime
        from xscript.android import system

        s = system.Schedule.daily("08:30", weekdays=[1, 2, 3, 4, 5])
        self.assertEqual((s["project"], s["kind"], s["weekdays"]), ("demo", "daily", [1, 2, 3, 4, 5]))
        system.Schedule.every(30, window="08:00-23:00", if_running="restart")
        system.Schedule.once(datetime.datetime(2030, 1, 2, 3, 4), project="other")
        once = self.fake.schedules[-1]
        self.assertEqual(once["project"], "other")
        self.assertEqual(once["at"], int(datetime.datetime(2030, 1, 2, 3, 4).timestamp() * 1000))
        self.assertEqual([x["kind"] for x in system.Schedule.list()], ["daily", "interval"])
        self.assertEqual(len(system.Schedule.list("*")), 3)
        self.assertEqual(system.Schedule.clear(), 2)
        self.assertEqual(len(system.Schedule.list("*")), 1)

    def test_schedule_error_raises(self):
        from xscript.android import system

        with self.assertRaises(ValueError) as cm:
            system.Schedule.daily("25:00")
        self.assertIn("HH:mm", str(cm.exception))

    def test_project_required(self):
        from xscript.android import system
        from xscript.runtime import runner

        runner._context["name"] = ""
        with self.assertRaises(ValueError):
            system.Schedule.daily("08:00")


if __name__ == "__main__":
    unittest.main()
