"""AScript compatibility: imports resolve and the query layer behaves like AScript with a fake tree."""

import json
import unittest

from xscript.runtime import bridge as bridge_mod

from test_selector import TREE


class FakeBridge(bridge_mod._MissingJava):
    def __init__(self):
        self.clicks = []
        self.node_actions = []

    def dump_tree(self, mode):
        return json.dumps({"mode": mode, "roots": TREE})

    def node_action(self, path, action, arg=""):
        self.node_actions.append((path, action, arg))
        return True

    def click(self, x, y, dur):
        self.clicks.append((x, y, dur))
        return True


class CompatImportTest(unittest.TestCase):
    def test_imports(self):
        from ascript.android.action import Key, Path, Touch, click, gesture, slide, swipe  # noqa: F401
        from ascript.android.node import Selector  # noqa: F401
        from ascript.android.system import R, Device, KeyValue, Config  # noqa: F401
        from ascript.android import system, screen, ui, media, data  # noqa: F401
        from ascript.android.ui import Canvas, Dialog, WebWindow, FloatWindow  # noqa: F401
        from ascript.android.screen import capture, FindColors, FindImages, Ocr, CompareColors  # noqa: F401
        from ascript.android.screen import gp, gp_tasks, color_tools, ascv  # noqa: F401
        import ascript.android  # noqa: F401


class CompatSelectorTest(unittest.TestCase):
    def setUp(self):
        self.fake = FakeBridge()
        self._patched = []
        for mod in ("xscript.android.node", "xscript.android.action"):
            m = __import__(mod, fromlist=["bridge"])
            self._patched.append((m, m.bridge))
            m.bridge = self.fake

    def tearDown(self):
        for m, b in self._patched:
            m.bridge = b

    def test_regex_text(self):
        from ascript.android.node import Selector

        nodes = Selector().text(".*Wi-Fi.*").find_all()
        self.assertEqual([n.text for n in nodes], ["Wi-Fi 已连接"])
        self.assertIsNone(Selector().text("nothing").find_all())

    def test_node_fields(self):
        from ascript.android.node import Selector

        n = Selector().id("com.android.settings:id/search").find()
        self.assertEqual(n.text, "Search")
        self.assertTrue(n.clickable)
        self.assertEqual(n.rect.left, 0)

    def test_chain_and_click(self):
        from ascript.android.node import Selector

        Selector().text("Network").child(1).click().find()
        self.assertEqual(self.fake.node_actions, [("0/1/0", "click", "")])

    def test_node_relatives(self):
        from ascript.android.node import Selector

        n = Selector().text("Internet").find()
        self.assertEqual(n.parent().text, "Network")
        self.assertEqual(n.brother(0.1).text, "Wi-Fi 已连接")
        self.assertEqual([c.text for c in n.parent().child()], ["Internet", "Wi-Fi 已连接", "Hotspot"])

    def test_dump(self):
        from ascript.android.node import Selector

        self.assertIn("Network", Selector.dump())

    def test_click_point(self):
        from ascript.android.action import click
        from xscript.android.image import Point

        click(Point(3, 4))
        click(5.7, 6.2)
        self.assertEqual(self.fake.clicks, [(3, 4, 20), (5, 6, 20)])


class CompatPathTest(unittest.TestCase):
    def test_path_strokes(self):
        from ascript.android.action import Path

        p = Path(0, 300)
        p.moveTo(10, 10)
        p.lineTo(100, 10)
        p.quadTo(150, 50, 100, 100)
        s = p.strokes()
        self.assertEqual(len(s), 1)
        self.assertEqual(s[0]["points"][0], (10.0, 10.0))
        self.assertEqual(s[0]["points"][-1], (100.0, 100.0))
        self.assertEqual(s[0]["duration"], 300)


class CompatResourceTest(unittest.TestCase):
    def test_r_paths(self):
        from ascript.android.system import R
        from xscript.runtime import runner

        runner._context["project_dir"] = "/data/proj/demo"
        try:
            self.assertEqual(R.img("a.png"), "/data/proj/demo/res/img/a.png")
            self.assertEqual(R.res("img/a.png"), "/data/proj/demo/res/img/a.png")
            self.assertEqual(R.root("game/x.yaml"), "/data/proj/demo/game/x.yaml")
            self.assertEqual(R.res("a", "b"), ["/data/proj/demo/res/a", "/data/proj/demo/res/b"])
        finally:
            runner._context["project_dir"] = ""


if __name__ == "__main__":
    unittest.main()
