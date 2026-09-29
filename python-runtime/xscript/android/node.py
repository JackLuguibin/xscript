"""Accessibility selector and node actions.

    from xscript.android import node
    n = node.Selector().text("搜索").find(timeout=5)
    if n:
        n.click()

String filters match exactly by default; call `.regex()` on the selector to treat them as
full-match regular expressions, or use `text_contains()`. Relations (`parent`, `child`,
`brother`) move the match set; filters after a relation apply to the new set.
"""

import json
import time

from xscript.android.tree import (  # noqa: F401  (re-exported for tests / callers)
    Pipeline,
    collect_matches,
    collect_related,
    find_by_path,
    match_node,
    run_xpath,
    walk,
)
from xscript.runtime.bridge import bridge

MODE_SIMPLE = 0
MODE_FULL = 1
MODE_NO_SYSTEM = 2


def dump(mode=0):
    """Full tree payload as a dict: {"mode", "width", "height", "roots": [...]}."""
    raw = bridge.dump_tree(int(mode))
    if not raw:
        return {"roots": []}
    if isinstance(raw, dict):
        return raw
    return json.loads(str(raw))


class Node(object):
    def __init__(self, data, mode=0):
        data = data or {}
        self._data = data
        self._mode = mode
        self.path = data.get("path") or ""
        self.id = data.get("id") or ""
        self.text = data.get("text") or ""
        self.desc = data.get("desc") or ""
        self.type = data.get("type") or ""
        self.hint = data.get("hint") or ""
        self.package = data.get("package") or ""
        self.class_path = data.get("classPath") or ""
        self.depth = int(data.get("depth") or 0)
        self.child_count = int(data.get("childCount", len(data.get("children") or [])))
        self.rect = data.get("rect") or {}
        self.clickable = bool(data.get("clickable"))
        self.long_clickable = bool(data.get("longClickable"))
        self.editable = bool(data.get("editable"))
        self.enabled = bool(data.get("enabled", True))
        self.visible = bool(data.get("visible", True))
        self.checkable = bool(data.get("checkable"))
        self.checked = bool(data.get("checked"))
        self.focusable = bool(data.get("focusable"))
        self.focused = bool(data.get("focused"))
        self.scrollable = bool(data.get("scrollable"))
        self.selected = bool(data.get("selected"))

    @property
    def raw(self):
        return self._data

    @property
    def left(self):
        return int(self.rect.get("l") or 0)

    @property
    def top(self):
        return int(self.rect.get("t") or 0)

    @property
    def right(self):
        return int(self.rect.get("r") or 0)

    @property
    def bottom(self):
        return int(self.rect.get("b") or 0)

    @property
    def width(self):
        return self.right - self.left

    @property
    def height(self):
        return self.bottom - self.top

    @property
    def center_x(self):
        return (self.left + self.right) // 2

    @property
    def center_y(self):
        return (self.top + self.bottom) // 2

    @property
    def children(self):
        return [Node(c, self._mode) for c in self._data.get("children") or []]

    def click(self):
        if self.path and bridge.node_action(self.path, "click"):
            return True
        from xscript.android import action

        return action.click(self.center_x, self.center_y)

    def long_click(self):
        if self.path and bridge.node_action(self.path, "long_click"):
            return True
        from xscript.android import action

        return action.click(self.center_x, self.center_y, 800)

    def set_text(self, text):
        return bool(self.path and bridge.node_action(self.path, "set_text", "" if text is None else str(text)))

    def scroll(self, forward=True):
        return bool(self.path and bridge.node_action(self.path, "scroll_forward" if forward else "scroll_backward"))

    def find(self, selector, timeout=0):
        """First match of `selector` inside this node's subtree."""
        hits = selector.within(self).find_all(timeout=timeout)
        return hits[0] if hits else None

    def find_all(self, selector, timeout=0):
        return selector.within(self).find_all(timeout=timeout)

    def to_dict(self):
        d = dict(self._data)
        d.pop("children", None)
        d["center_x"] = self.center_x
        d["center_y"] = self.center_y
        return d

    def __repr__(self):
        return "Node(text=%r, id=%r, type=%r, path=%r)" % (self.text, self.id, self.type.rsplit(".", 1)[-1], self.path)


class Selector(object):
    def __init__(self, mode=0, xpath=None):
        self._mode = int(mode)
        self._pipe = Pipeline()
        self._op = "exact"
        self._xpath = xpath
        self._scope = None
        self._actions = []

    # ---- matching mode
    def regex(self, enabled=True):
        """Treat string filters as full-match regular expressions (AScript semantics)."""
        self._op = "regex" if enabled else "exact"
        return self

    def _f(self, key, value, op=None):
        if value is not None:
            self._pipe.add_filter(key, op or self._op, value)
        return self

    # ---- string filters
    def text(self, value):
        return self._f("text", value)

    def text_contains(self, value):
        return self._f("text", value, "contains")

    def text_matches(self, pattern):
        return self._f("text", pattern, "regex")

    def id(self, value):
        return self._f("id", value)

    def desc(self, value):
        return self._f("desc", value)

    def desc_contains(self, value):
        return self._f("desc", value, "contains")

    def type(self, value):
        return self._f("type", value)

    def hint(self, value):
        return self._f("hint", value)

    def package(self, value):
        return self._f("package", value)

    def class_path(self, value):
        return self._f("classPath", value)

    def path(self, value):
        return self._f("path", value)

    # ---- flags / numbers
    def clickable(self, value=True):
        return self._f("clickable", bool(value))

    def long_clickable(self, value=True):
        return self._f("longClickable", bool(value))

    def editable(self, value=True):
        return self._f("editable", bool(value))

    def enabled(self, value=True):
        return self._f("enabled", bool(value))

    def visible(self, value=True):
        return self._f("visible", bool(value))

    def checkable(self, value=True):
        return self._f("checkable", bool(value))

    def checked(self, value=True):
        return self._f("checked", bool(value))

    def focusable(self, value=True):
        return self._f("focusable", bool(value))

    def focused(self, value=True):
        return self._f("focused", bool(value))

    def scrollable(self, value=True):
        return self._f("scrollable", bool(value))

    def selected(self, value=True):
        return self._f("selected", bool(value))

    def depth(self, *values):
        return self._f("depth", list(values))

    def child_count(self, *values):
        return self._f("childCount", list(values))

    def filter(self, fn):
        """Custom predicate on the raw node dict."""
        return self._f("__fn", fn)

    # ---- relations
    def parent(self, *which):
        """No args: all ancestors. parent(1) direct parent, parent(2) grandparent, parent(1.3) range."""
        self._pipe.add_relation("parent", which)
        return self

    def child(self, *which):
        """No args: all direct children. child(1) first, child(-1) last, child(1.3) range."""
        self._pipe.add_relation("child", which)
        return self

    def brother(self, *which):
        """No args: all siblings. brother(0.1) next, brother(-0.1) previous."""
        self._pipe.add_relation("brother", which)
        return self

    def descendant(self):
        self._pipe.add_relation("descendant", ())
        return self

    def within(self, node):
        sel = self.copy()
        sel._scope = node.path if isinstance(node, Node) else str(node)
        return sel

    def copy(self):
        s = Selector(self._mode, self._xpath)
        s._pipe = self._pipe.copy()
        s._op = self._op
        s._scope = self._scope
        s._actions = list(self._actions)
        return s

    # ---- queued actions (run on every hit of find/find_all)
    def click(self):
        self._actions.append(("click", None))
        return self

    def long_click(self):
        self._actions.append(("long_click", None))
        return self

    def input(self, text=""):
        self._actions.append(("set_text", text))
        return self

    def scroll(self, forward=True):
        self._actions.append(("scroll", forward))
        return self

    # ---- queries
    def _query(self):
        payload = dump(self._mode)
        roots = payload.get("roots") or []
        if self._xpath:
            hits = run_xpath(roots, self._xpath)
            if self._pipe.stages[0][2] or len(self._pipe.stages) > 1:
                paths = set(n.path for n in hits)
                hits = [n for n in self._pipe.run(roots) if n.path in paths] if paths else []
        else:
            hits = self._pipe.run(roots, scope=self._scope)
        return [Node(n.raw, self._mode) for n in hits]

    def _run_actions(self, nodes):
        for n in nodes:
            for name, arg in self._actions:
                if name == "click":
                    n.click()
                elif name == "long_click":
                    n.long_click()
                elif name == "set_text":
                    n.set_text(arg)
                elif name == "scroll":
                    n.scroll(arg)

    def find_all(self, timeout=0, limit=0):
        deadline = time.time() + max(0.0, float(timeout))
        while True:
            hits = self._query()
            if hits or time.time() >= deadline:
                break
            time.sleep(0.25)
        if limit:
            hits = hits[:limit]
        if self._actions:
            self._run_actions(hits[:1] if limit == 1 else hits)
        return hits

    def find(self, timeout=5):
        hits = self.find_all(timeout=timeout, limit=1)
        return hits[0] if hits else None

    def exists(self, timeout=0):
        return self.find(timeout=timeout) is not None

    def wait_gone(self, timeout=10):
        deadline = time.time() + float(timeout)
        while time.time() < deadline:
            if not self._query():
                return True
            time.sleep(0.25)
        return False
