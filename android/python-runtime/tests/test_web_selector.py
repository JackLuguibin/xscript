"""WebSelector / WebNode: Python spec building and result parsing (the JS half runs in
headless Chrome in scripts/tests/websel.test.cjs and on the emulator)."""
import json
import re
import unittest

from ascript.android.node import WebNode, WebSelector, _web_matcher
from ascript.android._websel_js import JS


class FakeWin:
    def __init__(self, rows=None):
        self.calls, self.rows = [], rows if rows is not None else []

    def js(self, code, timeout=5):
        assert code.startswith(JS)
        spec = json.loads(re.search(r"window\.__xsWeb\.query\((.*)\)$", code, re.S).group(1))
        self.calls.append((spec, timeout))
        return json.dumps(self.rows)


class FakeWebWindow:
    """Stands in for ascript.android.ui.WebWindow (exposes _ensure())."""

    def __init__(self, win):
        self.win = win

    def _ensure(self):
        return self.win


ROW = {"id": 3, "tag": "a", "text": "AScript 文档", "value": "", "attrs": {"href": "/docs", "class": "x"},
       "bounds": [10, 20, 110, 60]}


class WebSelectorTest(unittest.TestCase):
    def test_matcher_regex_and_exact(self):
        self.assertEqual(_web_matcher("百度一下"), {"s": "百度一下"})
        self.assertEqual(_web_matcher("/百度/"), {"re": "百度", "flags": ""})
        self.assertEqual(_web_matcher("/ab+c/gi"), {"re": "ab+c", "flags": "i"})
        self.assertEqual(_web_matcher("/usr/bin"), {"s": "/usr/bin"})  # not a regex: bad flags
        self.assertEqual(_web_matcher(None), {"s": ""})

    def test_chain_builds_spec_in_order(self):
        win = FakeWin([ROW])
        node = (WebSelector(FakeWebWindow(win)).tag("A").text("/AScript/").attr("href", "/docs")
                .value("").parent(1, 3).child(-1).brother(0.1).click().input("hi").find())
        spec, timeout = win.calls[0]
        self.assertEqual(timeout, 5)
        self.assertIsNone(spec["base"])
        self.assertEqual(spec["limit"], 1)
        self.assertEqual([s["k"] for s in spec["steps"]],
                         ["tag", "text", "attr", "value", "parent", "child", "brother"])
        self.assertEqual(spec["steps"][0]["m"], {"s": "a"})
        self.assertEqual(spec["steps"][2], {"k": "attr", "key": "href", "m": {"s": "/docs"}})
        self.assertEqual(spec["steps"][4]["args"], [1, 3])
        self.assertEqual(spec["steps"][6]["args"], [0.1])
        self.assertEqual(spec["actions"], [{"k": "click"}, {"k": "input", "arg": "hi"}])
        self.assertIsInstance(node, WebNode)

    def test_node_fields(self):
        node = WebSelector(FakeWin([ROW])).find()
        self.assertEqual((node.tag_name, node.text, node.value), ("a", "AScript 文档", ""))
        self.assertEqual(node.attributes["href"], "/docs")
        self.assertEqual((node.bounds.left, node.bounds.top, node.bounds.right, node.bounds.bottom), (10, 20, 110, 60))
        self.assertEqual((node.center_x, node.center_y), (60, 40))
        self.assertIn("<a>", repr(node))

    def test_find_all_limit_and_empty_results(self):
        win = FakeWin([ROW, dict(ROW, id=4)])
        self.assertEqual(len(WebSelector(win).find_all()), 2)
        self.assertEqual(win.calls[-1][0]["limit"], 0)
        WebSelector(win).find_all(5)
        self.assertEqual(win.calls[-1][0]["limit"], 5)
        win.rows = []
        self.assertIsNone(WebSelector(win).find())
        self.assertEqual(WebSelector(win).find_all(), [])
        with self.assertRaises(ValueError):
            WebSelector(win).find_all(-1)

    def test_timeout_or_garbage_reply_is_empty(self):
        class Dead:
            def js(self, code, timeout=5):
                return None
        self.assertIsNone(WebSelector(Dead()).find())

        class Garbage(Dead):
            def js(self, code, timeout=5):
                return "{not json"
        self.assertEqual(WebSelector(Garbage()).find_all(), [])

    def test_node_relations_and_actions_target_the_node(self):
        win = FakeWin([ROW])
        node = WebSelector(win).find()
        win.rows = [dict(ROW, id=7)]
        self.assertIsInstance(node.child(1), WebNode)
        spec = win.calls[-1][0]
        self.assertEqual((spec["base"], spec["steps"]), ([3], [{"k": "child", "args": [1]}]))
        win.rows = [dict(ROW, id=7), dict(ROW, id=8)]
        self.assertEqual(len(node.parent()), 2)  # several results -> list
        win.rows = []
        self.assertIsNone(node.brother(1))
        win.rows = [ROW]
        self.assertTrue(node.input("tom"))
        self.assertEqual(win.calls[-1][0]["actions"], [{"k": "input", "arg": "tom"}])
        self.assertTrue(node.long_click())
        self.assertTrue(node.click())
        self.assertEqual(win.calls[-1][0]["base"], [3])

    def test_bad_arguments(self):
        with self.assertRaises(TypeError):
            WebSelector(None)
        with self.assertRaises(TypeError):
            WebSelector(object()).find()
        for bad in ((0,), ("1",), (True,)):
            with self.assertRaises(ValueError):
                WebSelector(FakeWin()).child(*bad)
        with self.assertRaises(ValueError):
            WebSelector(FakeWin()).attr("", "x")

    def test_js_is_idempotent_and_self_contained(self):
        self.assertIn("window.__xsWeb.v === 1", JS)
        self.assertNotIn("import ", JS)


if __name__ == "__main__":
    unittest.main()
