import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { lintFile, plainMessage, projectSources } from "../lint";

test("lintFile reports the Web IDE's checks with VS Code wording", () => {
  const files = [
    { path: "lib.py", content: "def fetch_status():\n    return 1\n\n\nasync def load():\n    return 2\n" },
    {
      path: "__init__.py",
      content: "import os\nfrom lib import fetch_status, load\n\n\nasync def main():\n    load()\n    print(fetch_statu())\n    return\n    print('x')\n",
    },
  ];
  const got = lintFile(files, "__init__.py").map((p) => `${p.line}:${p.col} ${p.severity} ${p.message}`);
  assert.ok(got.includes("1:7 unused 未使用的 import os"), got.join("\n"));
  assert.ok(got.some((m) => m.startsWith("6:4 warning load") && m.includes("async 函数")), got.join("\n"));
  assert.ok(got.includes("7:10 warning 未定义的名字 fetch_statu（是不是 fetch_status？Ctrl/Cmd+. 改正）"), got.join("\n"));
  assert.ok(got.some((m) => /^9:4 unused 执行不到的代码（前面已经 return）$/.test(m)), got.join("\n"));
  assert.ok(got.every((m) => !m.includes("Ctrl+")), got.join("\n"));
  const typo = lintFile(files, "__init__.py").find((p) => p.line === 7);
  assert.deepEqual(typo?.fixes, [{ title: "改为 fetch_status", line: 7, col: 10, length: 11, text: "fetch_status", preferred: true }]);
  assert.ok(lintFile(files, "__init__.py").filter((p) => p.severity === "unused").every((p) => !p.fixes));
  assert.deepEqual(lintFile(files, "lib.py"), []);
});

test("lintFile offers `from m import name` after the docstring and imports", () => {
  const files = [
    { path: "util.py", content: "def helper():\n    return 1\n" },
    { path: "__init__.py", content: '"""Demo."""\nimport os\n\nprint(os.name, helper())\n' },
  ];
  const p = lintFile(files, "__init__.py").find((x) => x.message.startsWith("未定义的名字 helper"));
  assert.ok(p, JSON.stringify(lintFile(files, "__init__.py")));
  assert.ok(p.message.includes("Ctrl/Cmd+. 从 util 导入"), p.message);
  assert.deepEqual(p.fixes, [{ title: "从 util 导入 helper", line: 4, col: 0, length: 0, text: "from util import helper\n", preferred: true }]);
  // no trailing newline and nothing but imports: append on a new line at the end
  const bare = [files[0], { path: "__init__.py", content: "helper()" }];
  const q = lintFile(bare, "__init__.py").find((x) => x.fixes)!;
  assert.deepEqual(q.fixes?.[0], { title: "从 util 导入 helper", line: 1, col: 0, length: 0, text: "from util import helper\n", preferred: true });
});

test("plainMessage drops the Web IDE's Ctrl+. hints", () => {
  assert.equal(plainMessage("未定义的名字 sleep（Ctrl+. 从 time 导入）"), "未定义的名字 sleep（可以从 time 导入）");
  assert.equal(plainMessage("未使用的 import os（Ctrl+. 删除）"), "未使用的 import os");
  assert.equal(plainMessage("未定义的名字 x（Ctrl+. 选择要导入的模块）"), "未定义的名字 x");
  assert.equal(plainMessage("未定义的名字 sleep（Ctrl+. 从 time 导入）", true), "未定义的名字 sleep（Ctrl/Cmd+. 从 time 导入）");
});

test("projectSources reads .py files, skips caches and dot folders, prefers unsaved text", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xs-lint-"));
  try {
    fs.writeFileSync(path.join(root, "__init__.py"), "x = 1\n");
    fs.mkdirSync(path.join(root, "pkg"));
    fs.writeFileSync(path.join(root, "pkg", "a.py"), "y = 2\n");
    fs.writeFileSync(path.join(root, "pkg", "notes.txt"), "z");
    for (const d of ["__pycache__", ".venv"]) {
      fs.mkdirSync(path.join(root, d));
      fs.writeFileSync(path.join(root, d, "b.py"), "w = 3\n");
    }
    const got = projectSources(root, new Map([[path.join(root, "__init__.py"), "x = 9\n"]]));
    assert.deepEqual(got.sort((a, b) => a.path.localeCompare(b.path)), [
      { path: "__init__.py", content: "x = 9\n" },
      { path: "pkg/a.py", content: "y = 2\n" },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("no warnings on the repo's example and template projects", () => {
  const repo = path.resolve(__dirname, "..", "..", "..", "..");
  const roots: string[] = [];
  const find = (dir: string, depth: number) => {
    if (depth > 4 || !fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.name.startsWith(".") || ent.name === "node_modules" || ent.name === "__pycache__") continue;
      const full = path.join(dir, ent.name);
      if (fs.existsSync(path.join(full, "__init__.py")) && !fs.existsSync(path.join(dir, "__init__.py"))) roots.push(full);
      else find(full, depth + 1);
    }
  };
  find(path.join(repo, "examples"), 0);
  const warnings: string[] = [];
  for (const root of roots) {
    const files = projectSources(root);
    for (const f of files) for (const p of lintFile(files, f.path)) if (p.severity === "warning") warnings.push(`${root}/${f.path}:${p.line} ${p.message}`);
  }
  assert.ok(roots.length > 0, "found example projects");
  assert.deepEqual(warnings, []);
});
