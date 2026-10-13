"""XPath 1.0 subset over the dumped UI tree (uiautomator-style attribute names).

Supported:

- Paths: ``/``, ``//``, ``.``, ``..``, ``*``, ``node()``, and ``axis::test`` for child, descendant,
  descendant-or-self, parent, ancestor, ancestor-or-self, self, following-sibling and
  preceding-sibling. Name tests match the short class name (``TextView``) or the full one
  (``android.widget.TextView``).
- Predicates: ``[2]``, ``[last()]``, ``[last()-1]``, ``[position()<3]``, comparisons
  (``= != < <= > >=``), ``and`` / ``or`` / ``not()``, and nested paths used as existence
  tests (``//LinearLayout[.//TextView[@text='微信']]``).
- Grouping and union: ``(//Button)[1]``, ``//Button | //ImageButton``.
- Functions: text(), contains(), starts-with(), ends-with(), matches() (Python regex, search),
  string-length(), normalize-space(), concat(), string(), number(), count(), position(), last(),
  true(), false(), not(), boolean().

Attributes: text, resource-id / id, content-desc / desc, class / type, package, hint, bounds
(``[l,t][r,b]``), index (0-based sibling position), depth, child-count / childCount, and the
boolean flags (clickable, long-clickable, checkable, checked, editable, enabled, focusable,
focused, scrollable, selected, password, visible) as the strings "true" / "false".
"""

import re

from xscript.android.tree import index_tree

__all__ = ["XPathError", "compile_xpath", "select"]


class XPathError(ValueError):
    pass


# ---------------------------------------------------------------- tokenizer

_TOKEN = re.compile(
    r"""\s*(?:
        (?P<num>\d+(?:\.\d*)?|\.\d+)
      | (?P<str>"[^"]*"|'[^']*')
      | (?P<op>//|::|!=|<=|>=|\.\.|[/\[\]()@,|=<>*.+-])
      | (?P<name>[A-Za-z_][\w.\-]*)
    )""",
    re.X,
)


def _tokenize(text):
    tokens = []
    pos = 0
    text = text.strip()
    while pos < len(text):
        m = _TOKEN.match(text, pos)
        if not m or m.end() == pos:
            raise XPathError("unexpected character near %r" % text[pos:pos + 20])
        pos = m.end()
        kind = m.lastgroup
        value = m.group(kind)
        if kind == "str":
            value = value[1:-1]
        elif kind == "num":
            value = float(value)
        tokens.append((kind, value))
    return tokens


# ---------------------------------------------------------------- AST

_AXES = {
    "child", "descendant", "descendant-or-self", "parent", "ancestor", "ancestor-or-self",
    "self", "following-sibling", "preceding-sibling",
}
_FUNCS = {
    "text", "contains", "starts-with", "ends-with", "matches", "string-length", "normalize-space",
    "concat", "string", "number", "count", "position", "last", "true", "false", "not", "boolean",
}


class _Parser(object):
    def __init__(self, text):
        self.text = text
        self.toks = _tokenize(text)
        self.i = 0

    # -- token helpers
    def peek(self, offset=0):
        j = self.i + offset
        return self.toks[j] if j < len(self.toks) else (None, None)

    def take(self):
        tok = self.peek()
        self.i += 1
        return tok

    def accept(self, kind, value=None):
        k, v = self.peek()
        if k == kind and (value is None or v == value):
            self.i += 1
            return True
        return False

    def expect(self, kind, value=None):
        if not self.accept(kind, value):
            k, v = self.peek()
            raise XPathError("expected %r but found %r in %r" % (value or kind, v, self.text))

    def is_op(self, *values):
        k, v = self.peek()
        return k == "op" and v in values

    def is_name(self, *values):
        k, v = self.peek()
        return k == "name" and v in values

    # -- grammar
    def parse(self):
        if not self.toks:
            raise XPathError("empty xpath")
        node = self.or_expr()
        if self.i != len(self.toks):
            raise XPathError("unexpected %r in %r" % (self.peek()[1], self.text))
        return node

    def or_expr(self):
        left = self.and_expr()
        while self.is_name("or"):
            self.take()
            left = ("or", left, self.and_expr())
        return left

    def and_expr(self):
        left = self.eq_expr()
        while self.is_name("and"):
            self.take()
            left = ("and", left, self.eq_expr())
        return left

    def eq_expr(self):
        left = self.rel_expr()
        while self.is_op("=", "!="):
            op = self.take()[1]
            left = ("cmp", op, left, self.rel_expr())
        return left

    def rel_expr(self):
        left = self.add_expr()
        while self.is_op("<", ">", "<=", ">="):
            op = self.take()[1]
            left = ("cmp", op, left, self.add_expr())
        return left

    def add_expr(self):
        left = self.unary_expr()
        while self.is_op("+", "-"):
            op = self.take()[1]
            left = ("arith", op, left, self.unary_expr())
        return left

    def unary_expr(self):
        if self.is_op("-"):
            self.take()
            return ("neg", self.unary_expr())
        return self.union_expr()

    def union_expr(self):
        left = self.path_expr()
        while self.is_op("|"):
            self.take()
            left = ("union", left, self.path_expr())
        return left

    def path_expr(self):
        k, v = self.peek()
        # Filter expression: literal, number, function call or parenthesised expression,
        # optionally followed by predicates and a relative path.
        is_call = k == "name" and v in _FUNCS and self.peek(1) == ("op", "(")
        if k in ("str", "num") or is_call or (k == "op" and v == "("):
            primary = self.primary()
            preds = self.predicates()
            if preds:
                primary = ("filter", primary, preds)
            if self.is_op("/", "//"):
                return ("path", primary, self.relative_steps(leading=None))
            return primary
        if k == "op" and v in ("/", "//"):
            self.take()
            if v == "/" and not self._step_starts():
                return ("path", ("root",), [])
            steps = [] if v == "/" else [("descendant-or-self", "node()", [])]
            steps.extend(self.relative_steps(leading=False))
            return ("path", ("root",), steps)
        return ("path", ("context",), self.relative_steps(leading=False))

    def _step_starts(self):
        k, v = self.peek()
        return k == "name" or (k == "op" and v in ("*", ".", "..", "@"))

    def relative_steps(self, leading):
        steps = []
        if leading is None:
            # after a filter expression: expect / or //
            sep = self.take()[1]
            if sep == "//":
                steps.append(("descendant-or-self", "node()", []))
        steps.append(self.step())
        while self.is_op("/", "//"):
            sep = self.take()[1]
            if sep == "//":
                steps.append(("descendant-or-self", "node()", []))
            steps.append(self.step())
        return steps

    def step(self):
        if self.accept("op", ".."):
            return ("parent", "node()", [])
        if self.accept("op", "."):
            return ("self", "node()", [])
        axis = "child"
        if self.accept("op", "@"):
            k, v = self.take()
            if k != "name":
                raise XPathError("attribute name expected in %r" % self.text)
            return ("attribute", v, [])
        k, v = self.peek()
        if k == "name" and self.peek(1) == ("op", "::"):
            if v not in _AXES:
                raise XPathError("unsupported axis %s::" % v)
            axis = v
            self.i += 2
        test = self.node_test()
        return (axis, test, self.predicates())

    def node_test(self):
        if self.accept("op", "*"):
            return "*"
        k, v = self.take()
        if k != "name":
            raise XPathError("node test expected in %r" % self.text)
        if v == "node" and self.accept("op", "("):
            self.expect("op", ")")
            return "node()"
        return v

    def predicates(self):
        preds = []
        while self.accept("op", "["):
            preds.append(self.or_expr())
            self.expect("op", "]")
        return preds

    def primary(self):
        k, v = self.take()
        if k == "str":
            return ("lit", v)
        if k == "num":
            return ("num", v)
        if k == "op" and v == "(":
            inner = self.or_expr()
            self.expect("op", ")")
            return inner
        if k == "name":
            self.expect("op", "(")
            args = []
            if not self.is_op(")"):
                args.append(self.or_expr())
                while self.accept("op", ","):
                    args.append(self.or_expr())
            self.expect("op", ")")
            return ("call", v, args)
        raise XPathError("unexpected %r in %r" % (v, self.text))


_cache = {}


def compile_xpath(text):
    """Parse `text` into an AST (cached). Raises XPathError on syntax errors."""
    ast = _cache.get(text)
    if ast is None:
        ast = _Parser(text).parse()
        if len(_cache) > 256:
            _cache.clear()
        _cache[text] = ast
    return ast


# ---------------------------------------------------------------- evaluation

_ATTR_ALIASES = {
    "resource-id": "id", "content-desc": "desc", "class": "type", "long-clickable": "longClickable",
    "child-count": "childCount", "text": "text", "hint": "hint", "package": "package",
}
_BOOL_ATTRS = {
    "clickable", "longClickable", "checkable", "checked", "editable", "enabled", "focusable",
    "focused", "scrollable", "selected", "password", "visible", "dismissable",
}
_BOOL_TRUE_DEFAULT = {"enabled", "visible"}


class _Doc(object):
    """Indexed tree plus a virtual document root and document-order positions."""

    def __init__(self, roots):
        self.order, self.tops = index_tree(roots)
        self.pos = {id(n): i for i, n in enumerate(self.order)}


class _Root(object):
    """Virtual document node: its children are the top-level windows."""

    raw = {}
    parent = None
    index = 0

    def __init__(self, tops):
        self.children = tops


def _attr(node, name):
    raw = node.raw
    key = _ATTR_ALIASES.get(name, name)
    if key in _BOOL_ATTRS:
        value = raw.get(key)
        if value is None:
            value = key in _BOOL_TRUE_DEFAULT
        return "true" if value else "false"
    if key == "bounds":
        r = raw.get("rect") or {}
        return "[%d,%d][%d,%d]" % (r.get("l", 0), r.get("t", 0), r.get("r", 0), r.get("b", 0))
    if key == "index":
        return str(node.index)
    if key == "childCount":
        return str(raw.get("childCount", len(raw.get("children") or [])))
    if key in raw:
        value = raw.get(key)
        return "" if value is None else str(value)
    if key in ("id", "text", "desc", "type", "package", "hint", "path", "classPath"):
        return ""
    return None


def _name_matches(node, test):
    if test in ("*", "node()"):
        return True
    full = node.raw.get("type") or ""
    return full == test or full.rsplit(".", 1)[-1] == test


class _Ctx(object):
    __slots__ = ("node", "position", "size")

    def __init__(self, node, position=1, size=1):
        self.node = node
        self.position = position
        self.size = size


class _Evaluator(object):
    def __init__(self, doc):
        self.doc = doc
        self.root = _Root(doc.tops)

    def parent_of(self, node):
        if node is self.root:
            return None
        return node.parent if node.parent is not None else self.root

    def axis(self, node, axis):
        """Nodes on `axis` from `node`, in axis order (reverse axes nearest first)."""
        if axis == "child":
            return list(node.children)
        if axis == "self":
            return [node]
        if axis == "parent":
            p = self.parent_of(node)
            return [p] if p is not None else []
        if axis in ("ancestor", "ancestor-or-self"):
            out = [node] if axis == "ancestor-or-self" else []
            p = self.parent_of(node)
            while p is not None:
                out.append(p)
                p = self.parent_of(p)
            return out
        if axis in ("descendant", "descendant-or-self"):
            out = [node] if axis == "descendant-or-self" else []
            if node is self.root:
                return out + list(self.doc.order)
            stack = list(reversed(node.children))
            while stack:
                cur = stack.pop()
                out.append(cur)
                stack.extend(reversed(cur.children))
            return out
        if node is self.root:
            return []
        siblings = self.parent_of(node).children
        if axis == "following-sibling":
            return list(siblings[node.index + 1:])
        if axis == "preceding-sibling":
            return list(reversed(siblings[:node.index]))
        raise XPathError("unsupported axis %s" % axis)

    def sort(self, nodes):
        """Dedupe and put nodes in document order (the virtual root first)."""
        seen = set()
        out = []
        for n in nodes:
            k = id(n)
            if k not in seen:
                seen.add(k)
                out.append(n)
        out.sort(key=lambda n: -1 if n is self.root else self.doc.pos.get(id(n), 0))
        return out

    # -- value conversions
    @staticmethod
    def string(value):
        if isinstance(value, list):
            if not value:
                return ""
            first = value[0]
            return first if isinstance(first, str) else (first.raw.get("text") or "")
        if isinstance(value, bool):
            return "true" if value else "false"
        if isinstance(value, float):
            return str(int(value)) if value.is_integer() else repr(value)
        return "" if value is None else str(value)

    def number(self, value):
        if isinstance(value, bool):
            return 1.0 if value else 0.0
        if isinstance(value, float):
            return value
        try:
            return float(self.string(value).strip())
        except ValueError:
            return float("nan")

    @staticmethod
    def boolean(value):
        if isinstance(value, list):
            return bool(value)
        if isinstance(value, float):
            return value == value and value != 0
        if isinstance(value, str):
            return value != ""
        return bool(value)

    def _atoms(self, value):
        """Node-set members as strings (node string-value is its text)."""
        return [v if isinstance(v, str) else (v.raw.get("text") or "") for v in value]

    def compare(self, op, a, b):
        if isinstance(a, list) or isinstance(b, list):
            if isinstance(a, list) and isinstance(b, list):
                bs = self._atoms(b)
                return any(self._cmp_atomic(op, x, y) for x in self._atoms(a) for y in bs)
            if isinstance(a, list):
                if isinstance(b, bool):
                    return self._cmp_atomic(op, bool(a), b)
                return any(self._cmp_atomic(op, x, b) for x in self._atoms(a))
            if isinstance(a, bool):
                return self._cmp_atomic(op, a, bool(b))
            return any(self._cmp_atomic(op, a, y) for y in self._atoms(b))
        return self._cmp_atomic(op, a, b)

    def _cmp_atomic(self, op, a, b):
        if op in ("=", "!="):
            if isinstance(a, bool) or isinstance(b, bool):
                eq = self.boolean(a) == self.boolean(b)
            elif isinstance(a, float) or isinstance(b, float):
                eq = self.number(a) == self.number(b)
            else:
                eq = self.string(a) == self.string(b)
            return eq if op == "=" else not eq
        x, y = self.number(a), self.number(b)
        return {"<": x < y, "<=": x <= y, ">": x > y, ">=": x >= y}[op]

    # -- evaluation
    def eval(self, ast, ctx):
        kind = ast[0]
        if kind == "lit":
            return ast[1]
        if kind == "num":
            return ast[1]
        if kind == "or":
            return self.boolean(self.eval(ast[1], ctx)) or self.boolean(self.eval(ast[2], ctx))
        if kind == "and":
            return self.boolean(self.eval(ast[1], ctx)) and self.boolean(self.eval(ast[2], ctx))
        if kind == "cmp":
            return self.compare(ast[1], self.eval(ast[2], ctx), self.eval(ast[3], ctx))
        if kind == "arith":
            x, y = self.number(self.eval(ast[2], ctx)), self.number(self.eval(ast[3], ctx))
            return x + y if ast[1] == "+" else x - y
        if kind == "neg":
            return -self.number(self.eval(ast[1], ctx))
        if kind == "union":
            a, b = self.eval(ast[1], ctx), self.eval(ast[2], ctx)
            if not isinstance(a, list) or not isinstance(b, list):
                raise XPathError("| needs node-sets on both sides")
            return self.sort(a + b)
        if kind == "call":
            return self.call(ast[1], ast[2], ctx)
        if kind == "filter":
            value = self.eval(ast[1], ctx)
            if not isinstance(value, list):
                raise XPathError("predicates need a node-set")
            for pred in ast[2]:
                value = self.apply_predicate(value, pred)
            return value
        if kind == "path":
            return self.path(ast[1], ast[2], ctx)
        if kind == "root":
            return [self.root]
        if kind == "context":
            return [ctx.node]
        raise XPathError("unknown node %r" % (kind,))

    def path(self, start, steps, ctx):
        if start[0] == "root":
            current = [self.root]
        elif start[0] == "context":
            current = [ctx.node]
        else:
            current = self.eval(start, ctx)
            if not isinstance(current, list):
                raise XPathError("path step on a non node-set")
        for axis, test, preds in steps:
            if axis == "attribute":
                values = []
                for n in current:
                    if isinstance(n, str) or isinstance(n, _Root):
                        continue
                    v = _attr(n, test)
                    if v is not None:
                        values.append(v)
                current = values
                continue
            nxt = []
            for n in current:
                if isinstance(n, str):
                    continue
                cands = [
                    c for c in self.axis(n, axis)
                    # The virtual root only matches node(), never a class-name test.
                    if (test == "node()" if c is self.root else _name_matches(c, test))
                ]
                # Predicates see positions in axis order (reverse axes count nearest first).
                for pred in preds:
                    cands = self.apply_predicate(cands, pred)
                nxt.extend(cands)
            current = self.sort(nxt)
        return current

    def apply_predicate(self, nodes, pred):
        size = len(nodes)
        out = []
        for i, n in enumerate(nodes):
            value = self.eval(pred, _Ctx(n, i + 1, size))
            if isinstance(value, float):
                keep = value == i + 1
            else:
                keep = self.boolean(value)
            if keep:
                out.append(n)
        return out

    def call(self, name, args, ctx):
        vals = [self.eval(a, ctx) for a in args]

        def s(i):
            return self.string(vals[i]) if i < len(vals) else self.string([ctx.node])

        if name == "text":
            return ctx.node.raw.get("text") or ""
        if name == "position":
            return float(ctx.position)
        if name == "last":
            return float(ctx.size)
        if name == "true":
            return True
        if name == "false":
            return False
        if name == "not":
            return not self.boolean(vals[0])
        if name == "boolean":
            return self.boolean(vals[0])
        if name == "count":
            if not isinstance(vals[0], list):
                raise XPathError("count() needs a node-set")
            return float(len(vals[0]))
        if name == "string":
            return s(0)
        if name == "number":
            return self.number(vals[0]) if vals else self.number([ctx.node])
        if name == "string-length":
            return float(len(s(0)))
        if name == "normalize-space":
            return " ".join(s(0).split())
        if name == "concat":
            return "".join(self.string(v) for v in vals)
        if len(vals) < 2:
            raise XPathError("%s() needs two arguments" % name)
        a, b = self.string(vals[0]), self.string(vals[1])
        if name == "contains":
            return b in a
        if name == "starts-with":
            return a.startswith(b)
        if name == "ends-with":
            return a.endswith(b)
        if name == "matches":
            try:
                return re.search(b, a, re.S) is not None
            except re.error as e:
                raise XPathError("bad regex %r: %s" % (b, e))
        raise XPathError("unsupported function %s()" % name)


def select(roots, xpath):
    """Evaluate `xpath` against dumped roots; returns tree.Indexed nodes in document order."""
    ast = compile_xpath(xpath)
    ev = _Evaluator(_Doc(roots))
    value = ev.eval(ast, _Ctx(ev.root))
    if not isinstance(value, list):
        raise XPathError("xpath %r does not select nodes" % xpath)
    return [n for n in value if not isinstance(n, str) and n is not ev.root]
