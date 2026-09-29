"""Pure-Python query engine over the dumped UI tree.

The device dumps the tree as nested dicts (see NodeDumper.kt). This module indexes that
tree (parent links, sibling positions) and evaluates selector pipelines:

    stage filters -> relation (parent/child/brother) -> stage filters -> ...

Nothing here touches Java, so it runs in PC unit tests.
"""

import re

# Selector attribute -> dump key.
FIELD_ALIASES = {
    "hintText": "hint",
    "hint_text": "hint",
    "packageName": "package",
    "package_name": "package",
    "classPath": "classPath",
    "longClickable": "longClickable",
}

STRING_FIELDS = ("id", "text", "desc", "type", "hint", "package", "classPath")
BOOL_FIELDS = (
    "clickable", "checkable", "checked", "editable", "enabled", "dismissable", "focusable",
    "focused", "visible", "longClickable", "scrollable", "selected", "password",
)
INT_FIELDS = ("depth", "inputType", "drawingOrder", "maxTextLength", "childCount")


class Indexed(object):
    """Wraps one dumped node with tree links. `raw` is the original dict."""

    __slots__ = ("raw", "parent", "children", "index")

    def __init__(self, raw, parent, index):
        self.raw = raw
        self.parent = parent
        self.index = index
        self.children = []

    @property
    def path(self):
        return self.raw.get("path") or ""


def index_tree(roots):
    """Return (all_nodes_in_document_order, top_level_list)."""
    order = []
    tops = []

    def visit(raw, parent, idx):
        node = Indexed(raw, parent, idx)
        order.append(node)
        for i, child in enumerate(raw.get("children") or []):
            node.children.append(visit(child, node, i))
        return node

    for i, r in enumerate(roots or []):
        tops.append(visit(r, None, i))
    return order, tops


# ---------------------------------------------------------------- matching

_regex_cache = {}


def _regex(pattern):
    rx = _regex_cache.get(pattern)
    if rx is None:
        try:
            rx = re.compile(pattern, re.S)
        except re.error:
            rx = False
        if len(_regex_cache) > 512:
            _regex_cache.clear()
        _regex_cache[pattern] = rx
    return rx


def match_string(actual, expected, mode):
    """mode: 'exact' | 'regex' (equal or full regex match) | 'contains'."""
    actual = actual or ""
    expected = "" if expected is None else str(expected)
    if actual == expected:
        return True
    if mode == "contains":
        return expected in actual
    if mode == "regex":
        rx = _regex(expected)
        return bool(rx) and rx.fullmatch(actual) is not None
    return False


def _short_type(value):
    return (value or "").rsplit(".", 1)[-1]


def _short_id(value):
    value = value or ""
    return value.split(":id/", 1)[1] if ":id/" in value else value


def _int_ranges(values):
    """AScript numeric args: 3 -> [3,3]; 6.7 -> [6,7] (a float encodes an inclusive range)."""
    out = []
    for v in values:
        if isinstance(v, float) and not v.is_integer():
            a, b = _split_float(v)
            out.append((min(a, b), max(a, b)))
        else:
            n = int(v)
            out.append((n, n))
    return out


def _split_float(v):
    """1.3 -> (1, 3); -1.3 -> (-1, -3); 0.1 -> (0, 1). Uses the shortest repr."""
    text = repr(float(v))
    neg = text.startswith("-")
    text = text.lstrip("-")
    head, _, tail = text.partition(".")
    a = int(head or "0")
    b = int(tail or "0")
    if neg:
        return -a, -b
    return a, b


def match_filter(raw, key, op, value):
    key = FIELD_ALIASES.get(key, key)
    if key in BOOL_FIELDS:
        default = True if key in ("enabled", "visible") else False
        return bool(raw.get(key, default)) == bool(value)
    if key in INT_FIELDS:
        actual = raw.get(key)
        if actual is None:
            actual = len(raw.get("children") or []) if key == "childCount" else 0
        actual = int(actual)
        ranges = value if isinstance(value, (list, tuple)) else [value]
        return any(lo <= actual <= hi for lo, hi in _int_ranges(ranges))
    if key in STRING_FIELDS:
        actual = raw.get(key) or ""
        if match_string(actual, value, op):
            return True
        if key == "type":
            return match_string(_short_type(actual), value, op)
        if key == "id":
            return match_string(_short_id(actual), value, op)
        return False
    if key == "path":
        return match_string(raw.get("path") or "", value, op)
    if callable(value):
        return bool(value(raw))
    return (raw.get(key) or "") == value


def match_node(raw, filters, op="exact"):
    """filters: dict {field: value} (legacy xscript form) or list of (field, op, value)."""
    if not raw:
        return False
    if isinstance(filters, dict):
        items = [(k, op, v) for k, v in filters.items()]
    else:
        items = filters
    for key, fop, value in items:
        if not match_filter(raw, key, fop, value):
            return False
    return True


# ---------------------------------------------------------------- relations

def _dedupe(nodes):
    seen = set()
    out = []
    for n in nodes:
        k = id(n)
        if k not in seen:
            seen.add(k)
            out.append(n)
    return out


def _pick_indexed(items, args, allow_relative=False, current=None):
    """Select from `items` by AScript index args (1-based, negatives count from the end)."""
    if not args:
        return list(items)
    n = len(items)
    out = []
    for v in args:
        if isinstance(v, float) and not v.is_integer():
            a, b = _split_float(v)
            if allow_relative and a == 0 and current is not None:
                # brother(0.1) next sibling, brother(-0.1) previous (b is signed)
                pos = current + b
                if 0 <= pos < n:
                    out.append(items[pos])
                continue
            if a < 0 or b < 0:
                lo, hi = sorted((abs(a), abs(b)))
                for k in range(lo, hi + 1):
                    if 1 <= k <= n:
                        out.append(items[n - k])
            else:
                lo, hi = sorted((a, b))
                for k in range(lo, hi + 1):
                    if 1 <= k <= n:
                        out.append(items[k - 1])
        else:
            k = int(v)
            if k > 0 and k <= n:
                out.append(items[k - 1])
            elif k < 0 and -k <= n:
                out.append(items[n + k])
    return out


def relate(nodes, relation, args, tops=None):
    out = []
    for node in nodes:
        if relation == "parent":
            chain = []
            p = node.parent
            while p is not None:
                chain.append(p)
                p = p.parent
            out.extend(_pick_indexed(chain, args))
        elif relation == "child":
            out.extend(_pick_indexed(node.children, args))
        elif relation == "brother":
            siblings = node.parent.children if node.parent is not None else (tops or [])
            if not args:
                out.extend([s for s in siblings if s is not node])
            else:
                out.extend(_pick_indexed(siblings, args, allow_relative=True, current=node.index))
        elif relation == "descendant":
            stack = list(reversed(node.children))
            while stack:
                cur = stack.pop()
                out.append(cur)
                stack.extend(reversed(cur.children))
    return _dedupe(out)


class Pipeline(object):
    """Ordered selector stages. Each stage is (relation, args, filters)."""

    def __init__(self):
        self.stages = [[None, (), []]]

    def add_filter(self, key, op, value):
        self.stages[-1][2].append((key, op, value))

    def add_relation(self, relation, args):
        self.stages.append([relation, tuple(args), []])

    def copy(self):
        p = Pipeline()
        p.stages = [[r, a, list(f)] for r, a, f in self.stages]
        return p

    def run(self, roots, scope=None):
        """Evaluate against dumped `roots`. `scope`: optional path whose subtree bounds stage 0."""
        order, tops = index_tree(roots)
        if scope is not None:
            base = next((n for n in order if n.path == scope), None)
            if base is None:
                return []
            current = relate([base], "descendant", ())
        else:
            current = order
        first = True
        for relation, args, filters in self.stages:
            if not first and relation:
                current = relate(current, relation, args, tops)
            first = False
            if filters:
                current = [n for n in current if match_node(n.raw, filters)]
        return current


# ---------------------------------------------------------------- legacy helpers

def walk(nodes):
    for n in nodes or []:
        yield n
        for c in walk(n.get("children") or []):
            yield c


def find_by_path(nodes, path):
    for n in walk(nodes):
        if n.get("path") == path:
            return n
    return None


def collect_matches(nodes, filters, op="exact"):
    return [n for n in walk(nodes) if match_node(n, filters, op)]


def collect_related(roots, anchor_filters, relation, target_filters, op="exact"):
    """Legacy one-hop relation (child = direct children, parent = direct parent)."""
    p = Pipeline()
    for k, v in anchor_filters.items():
        p.add_filter(k, op, v)
    p.add_relation(relation, (1,) if relation == "parent" else ())
    for k, v in target_filters.items():
        p.add_filter(k, op, v)
    return [n.raw for n in p.run(roots)]


def parse_xpath(xpath):
    """Minimal XPath: //Type[@attr='v'][@attr2='v2']/Child... -> list of (axis, type, attrs).

    axis is 'descendant' for // and 'child' for /. Enough for AScript's documented form
    `//TextView[@text='开发者']`.
    """
    steps = []
    pos = 0
    text = xpath.strip()
    pattern = re.compile(r"(//|/)([\w.*]+)((?:\[[^\]]*\])*)")
    while pos < len(text):
        m = pattern.match(text, pos)
        if not m:
            raise ValueError("unsupported xpath near %r" % text[pos:])
        axis = "descendant" if m.group(1) == "//" else "child"
        typ = m.group(2)
        attrs = []
        for pred in re.findall(r"\[([^\]]*)\]", m.group(3) or ""):
            am = re.match(r"\s*@([\w-]+)\s*=\s*(['\"])(.*)\2\s*$", pred)
            if am:
                attrs.append((am.group(1), am.group(3)))
            elif pred.strip().isdigit():
                attrs.append(("__index", int(pred.strip())))
            else:
                raise ValueError("unsupported xpath predicate [%s]" % pred)
        steps.append((axis, typ, attrs))
        pos = m.end()
    return steps


_XPATH_ATTRS = {"resource-id": "id", "content-desc": "desc", "class": "type"}


def run_xpath(roots, xpath):
    order, tops = index_tree(roots)
    steps = parse_xpath(xpath)
    current = None
    for axis, typ, attrs in steps:
        if current is None:
            pool = order if axis == "descendant" else tops
        else:
            pool = relate(current, "descendant" if axis == "descendant" else "child", ())
        nxt = []
        for n in pool:
            if typ != "*" and not match_string(_short_type(n.raw.get("type")), typ, "exact") \
                    and not match_string(n.raw.get("type") or "", typ, "exact"):
                continue
            ok = True
            for key, val in attrs:
                if key == "__index":
                    continue
                key = _XPATH_ATTRS.get(key, key)
                if not match_filter(n.raw, key, "exact", val if key not in BOOL_FIELDS else val == "true"):
                    ok = False
                    break
            if ok:
                nxt.append(n)
        idx = [v for k, v in attrs if k == "__index"]
        if idx:
            nxt = [nxt[i - 1] for i in idx if 0 < i <= len(nxt)]
        current = nxt
    return current or []
