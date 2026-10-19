// Not a test file: runs generated flow Python against a stub xscript.android (python3 on PATH).
import { execFileSync } from "node:child_process";

// Runs generated Python against a stub `xscript.android`: `screen` lists the texts/ids that node.find can see.
const HARNESS = `
import sys, types, json
screen = set(json.loads(sys.argv[1]))
class _Node:
    def __init__(self, label): self.label = label
    def click(self): print("click", self.label)
class _Selector:
    def __init__(self): self.key = None
    def text(self, v): self.key = v; return self
    def id(self, v): self.key = v; return self
    def desc(self, v): self.key = v; return self
    def type(self, v): self.key = self.key or v; return self
    def path(self, v): self.key = self.key or v; return self
    def clickable(self): return self
    def find(self, timeout=0): return _Node(self.key) if self.key in screen else None
android = types.ModuleType("xscript.android")
android.node = types.SimpleNamespace(Selector=_Selector)
android.action = types.SimpleNamespace(sleep=lambda s: None)
android.system = types.SimpleNamespace(open=lambda p: print("open", p), params=lambda: {})
sys.modules["xscript"] = types.ModuleType("xscript")
sys.modules["xscript.android"] = android
exec(compile(sys.stdin.read(), "flow.py", "exec"), {"__name__": "__main__"})
`;

export function runFlowPython(python: string, screen: string[] = []): string[] {
  const out = execFileSync("python3", ["-c", HARNESS, JSON.stringify(screen)], { input: python, encoding: "utf8", timeout: 10000 });
  return out.split("\n").filter(Boolean);
}

