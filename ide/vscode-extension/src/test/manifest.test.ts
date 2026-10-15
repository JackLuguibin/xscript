import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
const en = JSON.parse(fs.readFileSync(path.join(ROOT, "package.nls.json"), "utf-8"));
const zh = JSON.parse(fs.readFileSync(path.join(ROOT, "package.nls.zh-cn.json"), "utf-8"));
const source = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf-8");

const commandIds: string[] = pkg.contributes.commands.map((c: { command: string }) => c.command);

test("every contributed command has a handler, and every handler a contribution", () => {
  const handlers = [...source.matchAll(/^\s+"(xscript\.[A-Za-z]+)":/gm)].map((m) => m[1]);
  assert.deepEqual([...new Set(handlers)].sort(), [...commandIds].sort());
  assert.equal(new Set(commandIds).size, commandIds.length, "no duplicate command ids");
});

test("menus, keybindings and the view only reference contributed commands", () => {
  const used = new Set<string>();
  for (const items of Object.values(pkg.contributes.menus) as { command: string }[][]) for (const i of items) used.add(i.command);
  for (const k of pkg.contributes.keybindings) used.add(k.command);
  for (const c of used) assert.ok(commandIds.includes(c), "unknown command " + c);
  const views = pkg.contributes.views.xscript.map((v: { id: string }) => v.id);
  assert.deepEqual(views, ["xscript.devices"]);
  assert.ok(source.includes('createTreeView("xscript.devices"'));
  assert.ok(pkg.contributes.viewsContainers.activitybar.some((c: { id: string }) => c.id === "xscript"));
});

test("AScript-style keybinding and Run / Stop toggle via the xscript.running context", () => {
  const key = (cmd: string) => pkg.contributes.keybindings.find((k: { command: string }) => k.command === cmd)?.key;
  assert.equal(key("xscript.run"), "ctrl+shift+r", "AScript runs with Ctrl+Shift+R");
  const when = (cmd: string) => pkg.contributes.menus["editor/title"].find((m: { command: string }) => m.command === cmd)?.when as string;
  assert.match(when("xscript.run"), /!xscript\.running/);
  assert.match(when("xscript.stop"), /&& xscript\.running/);
  assert.match(when("xscript.selectDevice"), /xscript\.isProject/);
});

test("every %key% in package.json exists in both language bundles", () => {
  const keys = [...JSON.stringify(pkg).matchAll(/%([A-Za-z0-9_.]+)%/g)].map((m) => m[1]);
  assert.ok(keys.length > 30);
  for (const k of keys) {
    assert.ok(typeof en[k] === "string" && en[k], "missing in package.nls.json: " + k);
    assert.ok(typeof zh[k] === "string" && zh[k], "missing in package.nls.zh-cn.json: " + k);
  }
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort(), "both bundles have the same keys");
});
