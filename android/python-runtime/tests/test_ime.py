"""XScript 输入法 Python side: xscript.android.ime and ascript action.Ime fallbacks (fake bridge, no device)."""
import json
import unittest
from unittest.mock import patch

from ascript.android import action
from xscript.android import ime


class FakeBridge:
    def __init__(self, active=True):
        self.active = active
        self.calls = []

    def control(self, op, arg=""):
        self.calls.append((op, arg))
        if op == "ime_status":
            return json.dumps({"id": "com.xscript.app/.ime.XscriptIme", "enabled": True, "selected": self.active, "active": self.active, "previous": None})
        if op == "ime_switch":
            return json.dumps({"switched": True, "active": True})
        if op == "ime_restore":
            return json.dumps({"restored": True})
        if not self.active:
            return json.dumps({"error": "XScript 输入法 is not active"})
        return "true"


class ImeModuleTest(unittest.TestCase):
    def setUp(self):
        self.fake = FakeBridge()
        p = patch.object(ime, "bridge", self.fake)
        p.start()
        self.addCleanup(p.stop)

    def test_ops(self):
        self.assertTrue(ime.is_active())
        self.assertTrue(ime.commit("你好"))
        self.assertEqual(self.fake.calls[-1], ("ime_commit", "你好"))
        ime.delete(2)
        self.assertEqual(json.loads(self.fake.calls[-1][1]), {"before": 2, "after": 0})
        ime.key(67)
        self.assertEqual(self.fake.calls[-1], ("ime_key", "67"))
        for f, op in ((ime.clear, "ime_clear"), (ime.enter, "ime_enter")):
            self.assertTrue(f())
            self.assertEqual(self.fake.calls[-1][0], op)
        self.assertTrue(ime.set_text(None))
        self.assertEqual(self.fake.calls[-1], ("ime_set_text", ""))
        self.assertTrue(ime.switch())
        self.assertTrue(ime.restore())

    def test_not_active_and_no_connection(self):
        self.fake.active = False
        with self.assertRaises(ime.ImeNotActive):
            ime.commit("x")
        with patch.object(ime, "bridge", type("B", (), {"control": lambda self, op, arg="": ""})()):
            self.assertFalse(ime.status()["active"])
            with self.assertRaises(ime.ImeNotActive):
                ime.switch()


class AscriptImeTest(unittest.TestCase):
    def setUp(self):
        self.fake = FakeBridge()
        self.xa_input = patch.object(action._xa, "input", return_value=True)
        self.xa_key = patch.object(action._xa.Key, "code")
        for p in (patch.object(ime, "bridge", self.fake), self.xa_input, self.xa_key, patch("time.sleep")):
            p.start()
            self.addCleanup(p.stop)

    def test_uses_ime_when_active(self):
        self.assertTrue(action.Ime.is_active())
        self.assertTrue(action.Ime.input("abc"))
        self.assertIn(("ime_commit", "abc"), self.fake.calls)
        action.Ime.input_clear()
        action.Ime.enter()
        action.Ime.keys([29, 30])
        action.Ime.delete(3)
        ops = [c[0] for c in self.fake.calls if c[0] != "ime_status"]
        self.assertEqual(ops, ["ime_commit", "ime_clear", "ime_enter", "ime_key", "ime_key", "ime_delete"])
        action._xa.input.assert_not_called()
        action._xa.Key.code.assert_not_called()

    def test_falls_back_when_not_active(self):
        self.fake.active = False
        self.assertTrue(action.Ime.input("abc"))
        action._xa.input.assert_called_with("abc")
        action.Ime.input_clear()
        action._xa.input.assert_called_with("")
        action.Ime.enter()
        action.Ime.delete(2)
        self.assertEqual([c.args[0] for c in action._xa.Key.code.call_args_list], [66, 67, 67])
        self.assertFalse(any(op in ("ime_commit", "ime_clear") for op, _ in self.fake.calls))


if __name__ == "__main__":
    unittest.main()
