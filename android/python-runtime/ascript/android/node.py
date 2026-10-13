"""ascript.android.node: Selector / Node with AScript semantics.

Differences from xscript.android.node:
- String constraints are regular expressions (full match), like AScript.
- find() / find_all() do not wait; find_all() returns None when empty.
- click()/long_click()/input()/slide() on a Selector are queued and run on found nodes.
"""

import json
from typing import List

from ascript._compat import Rect, warn_once
from xscript.android import node as _xn
from xscript.android.tree import Pipeline, run_xpath


class Node:
    def __init__(self, node=None, mode=0):
        raw = node.raw if isinstance(node, _xn.Node) else (node or {})
        self._raw = raw
        self._mode = mode
        self._x = _xn.Node(raw, mode)
        self.id = raw.get("id") or ""
        self.text = raw.get("text") or ""
        self.type = raw.get("type") or ""
        self.desc = raw.get("desc") or ""
        self.hintText = raw.get("hint") or ""
        self.packageName = raw.get("package") or ""
        self.path = raw.get("classPath") or ""
        self.node_path = raw.get("path") or ""
        self.rect = Rect.from_dump(raw.get("rect"))
        self.childCount = int(raw.get("childCount", len(raw.get("children") or [])))
        self.inputType = int(raw.get("inputType") or 0)
        self.maxTextLength = int(raw.get("maxTextLength") or 0)
        self.drawingOrder = int(raw.get("drawingOrder") or 0)
        self.depth = int(raw.get("depth") or 0)
        self.clickable = bool(raw.get("clickable"))
        self.checkable = bool(raw.get("checkable"))
        self.checked = bool(raw.get("checked"))
        self.editable = bool(raw.get("editable"))
        self.enabled = bool(raw.get("enabled", True))
        self.visible = bool(raw.get("visible", True))
        self.dismissable = bool(raw.get("dismissable"))
        self.focusable = bool(raw.get("focusable"))
        self.focused = bool(raw.get("focused"))
        self.heading = False
        self.longClickable = bool(raw.get("longClickable"))
        self.center_x = self.rect.centerX()
        self.center_y = self.rect.centerY()

    def to_dict(self):
        return {
            "id": self.id, "text": self.text, "type": self.type, "desc": self.desc,
            "hintText": self.hintText, "packageName": self.packageName, "path": self.path,
            "rect": list(self.rect), "childCount": self.childCount, "inputType": self.inputType,
            "maxTextLength": self.maxTextLength, "drawingOrder": self.drawingOrder, "depth": self.depth,
            "clickable": self.clickable, "checkable": self.checkable, "checked": self.checked,
            "editable": self.editable, "enabled": self.enabled, "visible": self.visible,
            "dismissable": self.dismissable, "focusable": self.focusable, "focused": self.focused,
            "longClickable": self.longClickable, "center_x": self.center_x, "center_y": self.center_y,
        }

    def find(self, selector):
        res = self.find_all(selector)
        return res[0] if res else None

    def find_all(self, selector):
        hits = selector._run(scope=self.node_path)
        return hits or []

    def _relative(self, relation, val):
        sel = Selector(self._mode)
        sel._pipe.add_filter("path", "exact", self.node_path)
        sel._pipe.add_relation(relation, val)
        res = sel._run()
        if not res:
            return None
        # One index (1, -1) or a relative sibling (0.1 / -0.1) → a single Node; ranges → list.
        single = len(val) == 1 and (float(val[0]).is_integer() or abs(float(val[0])) < 1)
        return res[0] if single else res

    def parent(self, *val):
        return self._relative("parent", val or (1,))

    def child(self, *val):
        if not val:
            return self._relative("child", ()) or []
        return self._relative("child", val)

    def brother(self, *val):
        if not val:
            return self._relative("brother", ()) or []
        return self._relative("brother", val)

    def click(self):
        self._x.click()
        return self

    def long_click(self):
        self._x.long_click()
        return self

    def swipe(self, ore=-1):
        return self.slide(ore)

    def slide(self, ore=-1):
        self._x.scroll(forward=int(ore) >= 0)
        return self

    def input(self, msg=""):
        self._x.set_text(msg)
        return self

    def __str__(self):
        return json.dumps(self.to_dict(), ensure_ascii=False)

    __repr__ = __str__


class _Cache(object):
    enabled = False
    payload = {}


class _A11yEvent(object):
    """AccessibilityEvent-style getters over an xscript event dict (Selector.on_event)."""

    def __init__(self, e):
        self._e = e
        self.event_type = e.get("event_type", 0)
        self.package_name = e.get("package", "")
        self.class_name = e.get("class", "")
        self.text = list(e.get("text") or [])

    def getEventType(self):
        return self.event_type

    def getPackageName(self):
        return self.package_name

    def getClassName(self):
        return self.class_name

    def getText(self):
        return self.text

    def getContentDescription(self):
        return self._e.get("desc", "")

    def getEventTime(self):
        return self._e.get("event_time", 0)

    def __repr__(self):
        return "AccessibilityEvent(%s %s %s)" % (self._e.get("event_name"), self.package_name, self.text)


class Selector:
    MODE_ACC_SIMPLE = 0
    MODE_ACC_ALL = 1
    MODE_ACC_FILTERED = 2
    MODE_ASS = 6
    MODE_ROOT = 9

    def __init__(self, mode=0, xpath=None):
        mode = int(mode)
        if mode in (6, 9):
            warn_once("sel-mode-%d" % mode, "Selector mode %d maps to XScript's current run mode" % mode)
            mode = 1
        self._mode = mode & 3
        self._xpath = xpath
        self._pipe = Pipeline()
        self._actions = []

    # ---- static helpers
    @staticmethod
    def cache(is_cache, mode=0):
        _Cache.enabled = bool(is_cache)
        _Cache.payload = {}
        if is_cache:
            _Cache.payload[int(mode) & 3] = _xn.dump(int(mode) & 3)

    @staticmethod
    def on_event(listener, mask=0):
        """Raw accessibility events (window changes, clicks, toasts, notifications...).

        `listener(e)` gets an event with e.getEventType(), e.getPackageName(), e.getClassName()
        and e.getText(), like AScript's AccessibilityEvent. Pass listener=None to stop.
        """
        from xscript.android import event as _ev

        _ev.off(event_type=_ev.ACCESSIBILITY)
        if listener is None:
            return None

        def wrapper(e):
            listener(_A11yEvent(e))

        return _ev.on_accessibility(mask)(wrapper)

    @staticmethod
    def dump(mode=0):
        return json.dumps(_xn.dump(int(mode) & 3), ensure_ascii=False)

    @staticmethod
    def refresh(mode=0):
        if _Cache.enabled:
            _Cache.payload[int(mode) & 3] = _xn.dump(int(mode) & 3)

    # ---- queries
    def _roots(self):
        if _Cache.enabled:
            payload = _Cache.payload.get(self._mode)
            if payload is None:
                payload = _Cache.payload[self._mode] = _xn.dump(self._mode)
        else:
            payload = _xn.dump(self._mode)
        return payload.get("roots") or []

    def _run(self, num=99999, scope=None):
        roots = self._roots()
        if self._xpath:
            hits = run_xpath(roots, self._xpath)
            has_filters = self._pipe.stages[0][2] or len(self._pipe.stages) > 1
            if has_filters:
                paths = set(n.path for n in hits)
                hits = [n for n in self._pipe.run(roots) if n.path in paths]
        else:
            hits = self._pipe.run(roots, scope=scope)
        nodes = [Node(n.raw, self._mode) for n in hits[:num]]
        for n in nodes:
            for name, arg in self._actions:
                if name == "click":
                    n.click()
                elif name == "long_click":
                    n.long_click()
                elif name == "slide":
                    n.slide(arg)
                elif name == "input":
                    n.input(arg)
        return nodes

    def find(self):
        res = self.find_all(1)
        return res[0] if res else None

    def find_all(self, num=99999) -> List[Node]:
        res = self._run(int(num))
        return res if res else None

    def find_by_text(self, text):
        return Selector(self._mode).text(text).find()

    def find_by_id(self, id):
        return Selector(self._mode).id(id).find()

    # ---- constraints (regex, full match)
    def _f(self, key, val, op="regex"):
        if val is None:
            return self
        self._pipe.add_filter(key, op, val)
        return self

    def id(self, val):
        return self._f("id", val)

    def text(self, val):
        return self._f("text", val)

    def type(self, val):
        return self._f("type", val)

    def desc(self, val):
        return self._f("desc", val)

    def hintText(self, val):
        return self._f("hint", val)

    def packageName(self, val):
        return self._f("package", val)

    def path(self, val):
        return self._f("classPath", val)

    def childCount(self, *val):
        return self._f("childCount", list(val)) if val else self

    def inputType(self, val):
        return self._f("inputType", [val])

    def drawingOrder(self, val):
        return self._f("drawingOrder", [val])

    def depth(self, val):
        return self._f("depth", [val])

    def maxTextLength(self, val):
        return self._f("maxTextLength", [val])

    def clickable(self, val=True):
        return self._f("clickable", bool(val))

    def checkable(self, val=True):
        return self._f("checkable", bool(val))

    def checked(self, val=True):
        return self._f("checked", bool(val))

    def editable(self, val=True):
        return self._f("editable", bool(val))

    def enabled(self, val=True):
        return self._f("enabled", bool(val))

    def dismissable(self, val=True):
        return self._f("dismissable", bool(val))

    def focusable(self, val=True):
        return self._f("focusable", bool(val))

    def focused(self, val=True):
        return self._f("focused", bool(val))

    def visible(self, val=True):
        return self._f("visible", bool(val))

    def longClickable(self, val=True):
        return self._f("longClickable", bool(val))

    # ---- relations
    def parent(self, *val):
        self._pipe.add_relation("parent", val)
        return self

    def child(self, *val):
        self._pipe.add_relation("child", val)
        return self

    def brother(self, *val):
        self._pipe.add_relation("brother", val)
        return self

    # ---- queued actions
    def click(self):
        self._actions.append(("click", None))
        return self

    def long_click(self):
        self._actions.append(("long_click", None))
        return self

    def swipe(self, ore=-1):
        return self.slide(ore)

    def slide(self, ore=-1):
        self._actions.append(("slide", ore))
        return self

    def input(self, msg=""):
        self._actions.append(("input", msg))
        return self

    @property
    def sel(self):
        return self


class WebSelector:
    """WebView DOM selection inside an AScript WebWindow is not supported."""

    def __init__(self, web_window=None):
        warn_once("websel", "WebSelector is not supported by XScript")

    def __getattr__(self, name):
        def _unsupported(*a, **k):
            raise NotImplementedError("WebSelector.%s is not supported by XScript" % name)
        return _unsupported


WebNode = WebSelector
