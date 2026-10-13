import unittest

from xscript.android.node import collect_matches, collect_related, match_node
from xscript.android.tree import Pipeline, parse_xpath, run_xpath


TREE = [
    {
        "path": "0",
        "id": "root",
        "text": "",
        "desc": "",
        "type": "android.widget.FrameLayout",
        "classPath": "/FrameLayout",
        "clickable": False,
        "children": [
            {
                "path": "0/0",
                "id": "com.android.settings:id/search",
                "text": "Search",
                "desc": "Search settings",
                "type": "android.widget.TextView",
                "clickable": True,
                "children": [],
            },
            {
                "path": "0/1",
                "id": "",
                "text": "Network",
                "desc": "",
                "type": "android.widget.LinearLayout",
                "clickable": False,
                "childCount": 3,
                "children": [
                    {"path": "0/1/0", "id": "", "text": "Internet", "type": "android.widget.TextView", "clickable": True, "children": []},
                    {"path": "0/1/1", "id": "", "text": "Wi-Fi 已连接", "type": "android.widget.TextView", "clickable": True, "children": []},
                    {"path": "0/1/2", "id": "", "text": "Hotspot", "type": "android.widget.Switch", "checkable": True, "checked": True, "children": []},
                ],
            },
        ],
    }
]


def run(pipe):
    return [n.path for n in pipe.run(TREE)]


class SelectorLogicTest(unittest.TestCase):
    def test_match_text(self):
        node = TREE[0]["children"][0]
        self.assertTrue(match_node(node, {"text": "Search"}))
        self.assertFalse(match_node(node, {"text": "Wifi"}))

    def test_collect_text(self):
        hits = collect_matches(TREE, {"text": "Search"})
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0]["id"], "com.android.settings:id/search")

    def test_child_relation(self):
        hits = collect_related(TREE, {"text": "Network"}, "child", {"text": "Internet"})
        self.assertEqual([h["path"] for h in hits], ["0/1/0"])

    def test_parent_relation(self):
        hits = collect_related(TREE, {"text": "Internet"}, "parent", {"text": "Network"})
        self.assertEqual([h["path"] for h in hits], ["0/1"])


class PipelineTest(unittest.TestCase):
    def test_regex_full_match(self):
        p = Pipeline()
        p.add_filter("text", "regex", ".*Wi-Fi.*")
        self.assertEqual(run(p), ["0/1/1"])
        p = Pipeline()
        p.add_filter("text", "regex", "Wi")
        self.assertEqual(run(p), [])

    def test_short_type_and_id(self):
        p = Pipeline()
        p.add_filter("type", "exact", "TextView")
        self.assertEqual(run(p), ["0/0", "0/1/0", "0/1/1"])
        p = Pipeline()
        p.add_filter("id", "exact", "search")
        self.assertEqual(run(p), ["0/0"])

    def test_child_index_and_negative(self):
        p = Pipeline()
        p.add_filter("text", "exact", "Network")
        p.add_relation("child", (1,))
        self.assertEqual(run(p), ["0/1/0"])
        p = Pipeline()
        p.add_filter("text", "exact", "Network")
        p.add_relation("child", (-1,))
        self.assertEqual(run(p), ["0/1/2"])

    def test_child_float_range(self):
        p = Pipeline()
        p.add_filter("text", "exact", "Network")
        p.add_relation("child", (1.2,))
        self.assertEqual(run(p), ["0/1/0", "0/1/1"])

    def test_brother_next_prev(self):
        p = Pipeline()
        p.add_filter("text", "exact", "Internet")
        p.add_relation("brother", (0.1,))
        self.assertEqual(run(p), ["0/1/1"])
        p = Pipeline()
        p.add_filter("text", "exact", "Hotspot")
        p.add_relation("brother", (-0.1,))
        self.assertEqual(run(p), ["0/1/1"])

    def test_brother_all_excludes_self(self):
        p = Pipeline()
        p.add_filter("text", "exact", "Internet")
        p.add_relation("brother", ())
        self.assertEqual(run(p), ["0/1/1", "0/1/2"])

    def test_parent_levels(self):
        p = Pipeline()
        p.add_filter("text", "exact", "Internet")
        p.add_relation("parent", (2,))
        self.assertEqual(run(p), ["0"])
        p = Pipeline()
        p.add_filter("text", "exact", "Internet")
        p.add_relation("parent", ())
        self.assertEqual(run(p), ["0/1", "0"])

    def test_bool_and_count(self):
        p = Pipeline()
        p.add_filter("checked", "exact", True)
        self.assertEqual(run(p), ["0/1/2"])
        p = Pipeline()
        p.add_filter("childCount", "exact", [3])
        self.assertEqual(run(p), ["0/1"])
        p = Pipeline()
        p.add_filter("childCount", "exact", [2.3])
        self.assertEqual(run(p), ["0", "0/1"])

    def test_filter_after_relation(self):
        p = Pipeline()
        p.add_filter("text", "exact", "Network")
        p.add_relation("child", ())
        p.add_filter("clickable", "exact", True)
        self.assertEqual(run(p), ["0/1/0", "0/1/1"])

    def test_scope(self):
        p = Pipeline()
        p.add_filter("clickable", "exact", True)
        self.assertEqual([n.path for n in p.run(TREE, scope="0/1")], ["0/1/0", "0/1/1"])


class XPathTest(unittest.TestCase):
    def test_parse(self):
        steps = parse_xpath("//TextView[@text='开发者']")
        self.assertEqual(steps, [("descendant", "TextView", [("text", "开发者")])])

    def test_run(self):
        self.assertEqual([n.path for n in run_xpath(TREE, "//TextView[@text='Internet']")], ["0/1/0"])
        self.assertEqual([n.path for n in run_xpath(TREE, "//LinearLayout/Switch")], ["0/1/2"])


if __name__ == "__main__":
    unittest.main()
