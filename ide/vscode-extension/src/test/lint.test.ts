import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Fix, lintFile, plainMessage, projectSources } from "../lint";

/** `text` with the quick fix's edits applied (back to front, as VS Code does). */
function apply(text: string, fix: Fix | undefined): string {
  assert.ok(fix && fix.edits, "no edit");
  for (const e of [...fix.edits].sort((a, b) => b.from - a.from)) text = text.slice(0, e.from) + e.text + text.slice(e.to);
  return text;
}

test("lintFile reports the Web IDE's checks with VS Code wording", () => {
  const files = [
    { path: "lib.py", content: "def fetch_status():\n    return 1\n\n\nasync def load():\n    return 2\n" },
    {
      path: "__init__.py",
      content: "import os\nfrom lib import fetch_status, load\n\n\nasync def main():\n    load()\n    print(fetch_statu())\n    return\n    print('x')\n",
    },
  ];
  const got = lintFile(files, "__init__.py").map((p) => `${p.line}:${p.col} ${p.severity} ${p.message}`);
  assert.ok(got.includes("1:7 unused 未使用的 import os（Ctrl/Cmd+. 删除）"), got.join("\n"));
  assert.ok(got.some((m) => m.startsWith("6:4 warning load") && m.includes("async 函数")), got.join("\n"));
  assert.ok(got.includes("7:10 warning 未定义的名字 fetch_statu（是不是 fetch_status？Ctrl/Cmd+. 改正）"), got.join("\n"));
  assert.ok(got.some((m) => /^9:4 unused 执行不到的代码（前面已经 return；Ctrl\/Cmd\+\. 删除）$/.test(m)), got.join("\n"));
  assert.ok(got.every((m) => !m.includes("Ctrl+")), got.join("\n"));
  const all = lintFile(files, "__init__.py"), src = files[1].content;
  const typo = all.find((p) => p.line === 7);
  assert.equal(typo?.fixes?.[0].title, "改为 fetch_status");
  assert.ok(apply(src, typo?.fixes?.[0]).includes("print(fetch_status())"));
  // unused import: the whole line goes
  assert.ok(apply(src, all.find((p) => p.line === 1)?.fixes?.[0]).startsWith("from lib import"));
  // unreachable code after return: its line goes, the return stays
  const dead = all.find((p) => p.line === 9)?.fixes?.[0];
  assert.equal(dead?.title, "删除 1 行执行不到的代码");
  assert.ok(apply(src, dead).endsWith("    return\n"), JSON.stringify(apply(src, dead)));
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
  assert.equal(p.fixes?.length, 1);
  assert.equal(p.fixes?.[0].title, "从 util 导入 helper");
  assert.equal(apply(files[1].content, p.fixes?.[0]), '"""Demo."""\nimport os\n\nfrom util import helper\nprint(os.name, helper())\n');
  // no trailing newline and nothing but imports: append on a new line at the end
  const bare = [files[0], { path: "__init__.py", content: "helper()" }];
  const q = lintFile(bare, "__init__.py").find((x) => x.fixes)!;
  assert.equal(apply("helper()", q.fixes?.[0]), "from util import helper\nhelper()");
});

test("lintFile offers the check's own edits and the jump to a duplicate definition", () => {
  const util = { path: "util.py", content: "def tap(x, y):\n    return x + y\n" };
  const main = { path: "__init__.py", content: "from util import tap\n\n\ndef run():\n    unused = 1\n    tap(540)\n\n\ndef run():\n    return 2\n" };
  const all = lintFile([util, main], "__init__.py");
  const args = all.find((p) => p.message.includes("缺少参数"));
  assert.ok(args, JSON.stringify(all));
  assert.ok(args.message.includes("Ctrl/Cmd+."), args.message);
  assert.ok(apply(main.content, args.fixes?.[0]).includes("tap(540, y=...)"));
  const v = all.find((p) => p.message.startsWith("未使用的变量 unused"));
  assert.ok(v?.fixes, JSON.stringify(all));
  assert.ok(!apply(main.content, v?.fixes?.[0]).includes("unused"), apply(main.content, v?.fixes?.[0]));
  const dup = all.find((p) => p.message.startsWith("重复定义"));
  assert.deepEqual(dup?.fixes, [{ title: "跳到第 4 行的定义", jump: { line: 4, col: 4 } }]);
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
