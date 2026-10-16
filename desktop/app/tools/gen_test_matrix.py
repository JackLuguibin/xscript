#!/usr/bin/env python3
"""Generate the case-ID table of docs/桌面端-测试方案.md from the test sources (so the document cannot drift from the tests).

    python desktop/app/tools/gen_test_matrix.py          # rewrite the generated block in the document
    python desktop/app/tools/gen_test_matrix.py --check  # exit 1 when the document is out of date (CI)

IDs are assigned per layer in file order (U-001, I-001, …); they are stable until a test is inserted before another in the same layer,
which is why the table is generated and never hand-edited. Python tests are read with `ast`, vitest tests with a regex over it()/test().
Parametrized tests count once here (the pytest run reports the expanded number).
"""
from __future__ import annotations

import ast
import re
import sys
from collections import OrderedDict
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
PY_TESTS = REPO / "desktop" / "app" / "tests"
JS_TESTS = REPO / "desktop" / "frontend" / "tests"
DOC = REPO / "docs" / "桌面端-测试方案.md"
BEGIN, END = "<!-- BEGIN GENERATED: test matrix (python desktop/app/tools/gen_test_matrix.py) -->", "<!-- END GENERATED: test matrix -->"

# layer id -> (prefix, title, python files, vitest files)
LAYERS = OrderedDict([
    ("unit", ("U", "单元（Python，纯逻辑，不需要 Qt/设备）",
              ["test_project_names", "test_adb", "test_adb_more", "test_device_client", "test_device_client_more", "test_rpc", "test_scheme", "test_runtime_bridge", "test_sync", "test_stub_completions"], [])),
    ("integration", ("I", "集成（服务层 + FakeDevice/FakeAdb/子进程，含错误路径矩阵）",
                     ["test_device_manager", "test_context", "test_errors_matrix", "test_main_cli", "test_projects_rpc", "test_dialogs", "test_debugger", "test_app_icon", "test_packaging"], [])),
    ("frontend", ("F", "前端（vitest + testing-library，MemoryTransport 代替 Python）", [],
                  ["client.test.ts", "boot.test.ts", "qt-transport.test.ts", "demo.test.ts", "app.test.tsx", "devicepage.test.tsx", "devicepage-more.test.tsx", "states.test.tsx", "theme.test.tsx", "contrast.test.ts",
                   "projects.test.tsx", "codeeditor.test.tsx", "completions.test.ts", "sync.test.tsx", "mirror.test.tsx", "fileops-i18n.test.tsx", "debugger.test.tsx"])),
    ("e2e", ("E", "端到端（真实外壳：离屏 QtWebEngine + 真实构建的 React + xsapp:// + QWebChannel + Python 服务）", ["test_e2e_ui", "test_shell", "test_e2e_projects", "test_e2e_debugger"], [])),
    ("security", ("S", "安全（CSP、导航白名单、路径穿越、前端禁止联网、adb 命令白名单、密钥）", ["test_security"], ["no-direct-network.test.ts"])),
    ("visual", ("V", "视觉回归（截图基线，按平台）", ["test_visual", "test_visual_util"], [])),
    ("perf", ("P", "性能预算（宽松上限，防回归）", ["test_perf"], [])),
    ("windows", ("W", "Windows 逻辑模拟（不是 Windows 验证；真机清单见设计 §14.9）", ["test_windows_sim"], [])),
    ("device", ("D", "真机/模拟器（需 XSCRIPT_DEVICE_TESTS=1，默认跳过）", ["test_device_e2e"], [])),
])


def py_cases(stem: str) -> list[tuple[str, str, bool]]:
    f = PY_TESTS / (stem + ".py")
    if not f.exists():
        return []
    out = []
    for n in ast.parse(f.read_text()).body:
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name.startswith("test_"):
            doc = (ast.get_docstring(n) or "").strip().splitlines()
            desc = doc[0] if doc else n.name[5:].replace("_", " ")
            param = any("parametrize" in ast.unparse(d) for d in n.decorator_list)
            out.append((n.name, desc, param))
    return out


def js_cases(name: str) -> list[tuple[str, str, bool]]:
    f = JS_TESTS / name
    if not f.exists():
        return []
    out = []
    for m in re.finditer(r"^\s*(?:it|test)(?:\.each\([^)]*\))?\(\s*(?P<q>[\"'`])(?P<t>.*?)(?P=q)", f.read_text(), re.M):
        out.append((m.group("t"), m.group("t"), "each" in m.group(0)))
    return out


def esc(s: str) -> str:
    return s.replace("|", "\\|").replace("\n", " ")


def render() -> str:
    lines = [BEGIN, "", "| 层 | 前缀 | 用例函数数 |", "|---|---|---|"]
    body: list[str] = []
    total = 0
    for key, (prefix, title, pys, jss) in LAYERS.items():
        rows = []
        for stem in pys:
            rows += [("desktop/app/tests/%s.py::%s" % (stem, n), d, p) for n, d, p in py_cases(stem)]
        for name in jss:
            rows += [("desktop/frontend/tests/%s :: %s" % (name, n), d, p) for n, d, p in js_cases(name)]
        total += len(rows)
        lines.append("| %s | `%s-` | %d |" % (title.split("（")[0], prefix, len(rows)))
        body += ["", "#### %s-xxx　%s" % (prefix, title), ""]
        if not rows:
            body.append("（本层用例随后续提交补充。）")
            continue
        body += ["| ID | 用例 | 位置 | 参数化 |", "|---|---|---|---|"]
        for i, (loc, d, p) in enumerate(rows, 1):
            body.append("| %s-%03d | %s | `%s` | %s |" % (prefix, i, esc(d), esc(loc), "是" if p else ""))
    lines.append("| **合计** | | **%d** |" % total)
    return "\n".join(lines + body + ["", END])


def unregistered() -> list[str]:
    """Test files that no layer lists (they would silently be missing from the document)."""
    py = {s for (_, _, ps, _) in LAYERS.values() for s in ps}
    js = {s for (_, _, _, js_) in LAYERS.values() for s in js_}
    out = sorted("desktop/app/tests/%s" % f.name for f in PY_TESTS.glob("test_*.py") if f.stem not in py)
    out += sorted("desktop/frontend/tests/%s" % f.name for f in JS_TESTS.glob("*.test.ts*") if f.name not in js)
    return out


def main(argv: list[str]) -> int:
    missing = unregistered()
    if missing:
        print("test files not assigned to a layer in LAYERS: %s" % ", ".join(missing), file=sys.stderr)
        return 1
    text = DOC.read_text()
    if BEGIN not in text or END not in text:
        print("markers not found in %s" % DOC, file=sys.stderr)
        return 2
    new = text[: text.index(BEGIN)] + render() + text[text.index(END) + len(END):]
    if "--check" in argv:
        if new != text:
            print("%s is out of date: run python desktop/app/tools/gen_test_matrix.py" % DOC.relative_to(REPO), file=sys.stderr)
            return 1
        print("test matrix up to date")
        return 0
    DOC.write_text(new)
    print("updated", DOC.relative_to(REPO))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
