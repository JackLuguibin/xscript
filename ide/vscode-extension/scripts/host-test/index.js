// Runs INSIDE the VS Code extension host (launched with --extensionTestsPath, see scripts/vscode-host-test.sh):
// checks that the installed vsix activates and registers its commands, debugger type, keybindings and menus.
// Results go to $XS_HOST_TEST_OUT as JSON (the editor swallows stdout).
const fs = require("fs");
const os = require("os");
const path = require("path");
const vscode = require("vscode");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function http(base, method, route, body) {
  const r = await fetch(base + route, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  try { return { status: r.status, json: JSON.parse(text) }; } catch { return { status: r.status, text }; }
}

exports.run = async function run() {
  const out = process.env.XS_HOST_TEST_OUT;
  const checks = [];
  const check = (ok, what, extra) => checks.push({ ok: !!ok, what, extra });
  try {
    const ext = vscode.extensions.getExtension("xscript.xscript-vscode");
    check(!!ext, "extension xscript.xscript-vscode is installed", ext && ext.extensionPath);
    if (ext) {
      await ext.activate();
      check(ext.isActive, "extension activates");
      const pj = ext.packageJSON;
      const want = (pj.contributes.commands || []).map((c) => c.command);
      const have = await vscode.commands.getCommands(true);
      const missing = want.filter((c) => !have.includes(c));
      check(want.length >= 25 && missing.length === 0, `all ${want.length} contributed commands are registered`, missing.join(",") || undefined);
      check((pj.contributes.viewsContainers.activitybar || []).some((c) => c.id === "xscript") && (pj.contributes.views.xscript || []).some((v) => v.id === "xscript.devices"), "activity-bar container + xscript.devices view contributed");
      check((pj.contributes.keybindings || []).some((k) => k.command === "xscript.run" && k.key === "ctrl+shift+r"), "Ctrl+Shift+R keybinding for run (AScript's)");
      check((pj.contributes.debuggers || []).some((d) => d.type === "xscript"), "debugger type xscript contributed");
      check((pj.contributes.keybindings || []).some((k) => k.command === "xscript.debug" && k.key === "alt+f6"), "Alt+F6 keybinding for debug");
      // a command that needs no device: it should run (and report an error toast at most), never be "not found"
      let threw = "";
      try { await Promise.race([vscode.commands.executeCommand("xscript.status"), new Promise((r) => setTimeout(r, 4000))]); } catch (e) { threw = String(e && e.message || e); }
      check(!/not found/i.test(threw), "xscript.status executes (no 'command not found')", threw || undefined);
      // debug configuration provider resolves a bare config
      const folder = (vscode.workspace.workspaceFolders || [])[0];
      check(!!folder, "workspace folder with __init__.py is open", folder && folder.uri.fsPath);
      let py = [];
      for (let i = 0; i < 5 && !py.length; i++) { // the window may still be starting: findFiles can be Canceled at first
        try { py = await vscode.workspace.findFiles("**/__init__.py", null, 1); } catch { await sleep(1000); }
      }
      check(py.length === 1, "workspaceContains:**/__init__.py found the project file");
      // basic checks: a project file with an undefined name and an unused import shows both in Problems
      {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "xs-host-lint-"));
        const file = path.join(root, "__init__.py");
        fs.writeFileSync(file, "import os\ntotal = 1\nprint(totl)\n");
        try {
          const uri = vscode.Uri.file(file);
          await vscode.window.showTextDocument(uri);
          let diags = [];
          for (let i = 0; i < 20 && diags.length < 2; i++) { await sleep(300); diags = vscode.languages.getDiagnostics(uri).filter((d) => d.source === "XScript"); }
          const msgs = diags.map((d) => d.message);
          check(msgs.includes("未定义的名字 totl（是不是 total？Ctrl/Cmd+. 改正）") && msgs.includes("未使用的 import os"), "Problems show the basic checks (undefined name, unused import)", msgs.join(" | "));
          // Ctrl/Cmd+.: the "是不是 total" quick fix renames totl in place
          const typo = diags.find((d) => d.message.startsWith("未定义的名字 totl"));
          const actions = typo ? await vscode.commands.executeCommand("vscode.executeCodeActionProvider", uri, typo.range, "quickfix") : [];
          const rename = (actions || []).find((a) => a.title === "改为 total");
          if (rename && rename.edit) await vscode.workspace.applyEdit(rename.edit);
          const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
          check(!!rename && !!rename.isPreferred && doc && doc.lineAt(2).text === "print(total)", "Quick fix renames a misspelled name", (actions || []).map((a) => a.title).join(" | ") + " / " + (doc && doc.lineAt(2).text));
          await vscode.commands.executeCommand("workbench.action.files.revert");
          await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      }
      await flows(ext, check, folder);
    }
  } catch (e) {
    check(false, "host test threw", String(e && e.stack || e));
  }
  if (out) fs.writeFileSync(out, JSON.stringify(checks, null, 2));
  if (checks.some((c) => !c.ok)) throw new Error("host checks failed: " + checks.filter((c) => !c.ok).map((c) => c.what).join("; "));
};

// Real command flows against a device (the mock in vscode-host-test.sh, or XS_HOST_TEST_DEVICE=127.0.0.1:<forwarded port>).
async function flows(ext, check, folder) {
  const addr = process.env.XS_HOST_TEST_DEVICE;
  if (!addr) return void check(true, "no XS_HOST_TEST_DEVICE: command flows skipped");
  const real = process.env.XS_HOST_TEST_REAL === "1";
  const base = "http://" + addr;
  const api = ext.exports;
  check(api && api.store && api.tree, "extension exports the device store and tree");
  await vscode.workspace.getConfiguration("xscript").update("device", addr, vscode.ConfigurationTarget.Workspace);
  await sleep(300);
  const name = "xs_host_" + Date.now().toString(36);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "xs-host-"));
  try {
    // devices: add, tree, edit, scan, remove
    const added = await vscode.commands.executeCommand("xscript.addDevice", { name: "Host test", address: addr, quiet: true });
    check(added && added.address === addr, "addDevice saves the device", JSON.stringify(added));
    check(api.store.list().some((d) => d.address === addr && d.name === "Host test"), "device store lists it");
    const groups = await api.tree.getChildren();
    check(groups.length === 3, "side bar has Devices / Projects / Tools groups", groups.map((g) => g.label).join(","));
    const devs = await api.tree.getChildren(groups[0]);
    const mine = devs.find((d) => d.device && d.device.address === addr);
    check(mine && /^xscript\.device\.(idle|running)$/.test(mine.contextValue), "device node is online (idle/running)", mine && mine.contextValue);
    const tools = await api.tree.getChildren(groups[2]);
    check(tools.length >= 8 && tools.every((t) => t.command && t.command.command), `Tools group has ${tools.length} commands`);
    await vscode.commands.executeCommand("xscript.editDevice", { name: "Host test", address: addr, newName: "Renamed", newAddress: addr });
    check(api.store.list().some((d) => d.address === addr && d.name === "Renamed"), "editDevice renames");
    const lanHosts = process.env.XS_HOST_TEST_LAN_HOSTS;
    if (lanHosts) {
      const found = await vscode.commands.executeCommand("xscript.scanDevices", { adb: false, lan: true, hosts: lanHosts.split(",") });
      check(found.length >= 1 && found.every((d) => d.via === "lan"), "LAN scan finds the device", JSON.stringify(found.map((d) => d.address)));
    }
    if (process.env.XS_HOST_TEST_ADB === "1") {
      const found = await vscode.commands.executeCommand("xscript.scanDevices", { adb: true, lan: false });
      check(found.some((d) => d.address === addr) && found.every((d) => d.via === "adb"), "ADB scan finds the forwarded emulator(s)", JSON.stringify(found.map((d) => d.address)));
    }

    // new project (template), then run twice (second run re-syncs only changes and restarts), stop, pull
    const dir = await vscode.commands.executeCommand("xscript.newProject", { parent: tmp, name, template: "empty", open: false });
    check(dir === path.join(tmp, name) && fs.existsSync(path.join(dir, "build.as")) && fs.existsSync(path.join(dir, "__init__.py")), "newProject creates __init__.py + build.as", dir);
    // UI designer: New UI Form opens res/ui/<name>.ui.json in the custom editor; saving an edit regenerates html + py
    {
      const uiRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xs-host-ui-"));
      fs.writeFileSync(path.join(uiRoot, "__init__.py"), "");
      const uri = await vscode.commands.executeCommand("xscript.newUiForm", { root: uiRoot, name: "hostform" });
      const specFile = path.join(uiRoot, "res", "ui", "hostform.ui.json");
      check(uri && fs.existsSync(specFile) && fs.existsSync(path.join(uiRoot, "res", "ui", "hostform.html")) && fs.existsSync(path.join(uiRoot, "ui_hostform.py")),
        "newUiForm creates the spec, res/ui/hostform.html and ui_hostform.py");
      await sleep(800);
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
      const input = tab && tab.input;
      check(input instanceof vscode.TabInputCustom && input.viewType === "xscript.uiDesigner", "the .ui.json opens in the XScript UI designer", tab && tab.label);
      const doc = await vscode.workspace.openTextDocument(specFile);
      const spec = JSON.parse(doc.getText());
      spec.fields.push({ kind: "select", id: "mode", label: "Mode", options: ["fast", "safe"], default: "safe" });
      const edit = new vscode.WorkspaceEdit();
      edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), JSON.stringify(spec, null, 2) + "\n");
      await vscode.workspace.applyEdit(edit);
      await doc.save();
      await sleep(500);
      const py = fs.readFileSync(path.join(uiRoot, "ui_hostform.py"), "utf-8");
      check(/"mode": "safe"/.test(py) && /data-key="mode"/.test(fs.readFileSync(path.join(uiRoot, "res", "ui", "hostform.html"), "utf-8")), "saving the edited form regenerates the html and Python");
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    }
    fs.writeFileSync(path.join(dir, "__init__.py"), 'import time\nprint("host-test-start", flush=True)\nfor _ in range(60):\n    time.sleep(0.5)\n');
    fs.writeFileSync(path.join(dir, "notes.skip"), "ignored");
    fs.mkdirSync(path.join(dir, ".vscode"), { recursive: true });
    await vscode.commands.executeCommand("xscript.editSyncIgnore", vscode.Uri.file(dir));
    fs.writeFileSync(path.join(dir, ".vscode", ".syncignore"), "*.skip\n");
    await vscode.commands.executeCommand("xscript.run", vscode.Uri.file(path.join(dir, "__init__.py")));
    await sleep(real ? 4000 : 800);
    let files = (await http(base, "GET", "/projects/" + name + "/files")).json;
    const paths = (files.files || []).map((f) => f.path).sort();
    check(paths.includes("__init__.py") && paths.includes("build.as") && !paths.includes("notes.skip"), "run uploaded the project and honoured .syncignore", paths.join(","));
    let st = (await http(base, "GET", "/status")).json;
    check(st.running === true && st.project === name, "project is running on the device", JSON.stringify({ running: st.running, project: st.project }));
    fs.writeFileSync(path.join(dir, "__init__.py"), 'import time\nprint("host-test-second", flush=True)\nfor _ in range(60):\n    time.sleep(0.5)\n');
    await vscode.commands.executeCommand("xscript.run", vscode.Uri.file(path.join(dir, "__init__.py")));
    await sleep(real ? 4000 : 800);
    const remote = (await http(base, "GET", "/projects/" + name + "/file?path=__init__.py")).json;
    check(remote && /host-test-second/.test(remote.content || ""), "re-run synced only the changed file and restarted", String(remote && remote.content).slice(0, 60));
    // the restart is stop -> idle -> upload -> start; on a loaded emulator that can take longer than the fixed wait
    for (let i = 0; i < 20 && !(st.running === true && st.project === name); i++) { await sleep(1000); st = (await http(base, "GET", "/status")).json; }
    check(st.running === true && st.project === name, "project runs again after the re-run");
    if (real) {
      const logs = (await http(base, "GET", "/logs?since=0")).json;
      const lines = (logs.entries || []).map((e) => e.line).join("");
      check(/host-test-start/.test(lines) && /host-test-second/.test(lines), "device logs show both runs (stopped, then restarted)");
    }
    await vscode.commands.executeCommand("xscript.stop");
    await sleep(real ? 1500 : 400);
    st = (await http(base, "GET", "/status")).json;
    check(st.running === false, "stop ends the run");
    const dest = path.join(tmp, "pulled");
    const pulled = await vscode.commands.executeCommand("xscript.pullProject", { project: name, dest, overwrite: true });
    check(pulled && pulled.written >= 2 && fs.readFileSync(path.join(dest, "__init__.py"), "utf-8").includes("host-test-second"), "pullProject writes the device's files", JSON.stringify(pulled && { written: pulled.written }));
    const projects = await api.tree.getChildren(groups[1]);
    check(projects.some((p) => p.project === name), "Projects group lists the project on the device");
    // status bar, side-bar view focus, screenshot
    await api.refreshStatus();
    check(/^\$\(device-mobile\)/.test(api.statusText()), "status bar shows the connected device", api.statusText());
    let focusErr = "";
    try { await vscode.commands.executeCommand("workbench.view.extension.xscript"); await vscode.commands.executeCommand("xscript.devices.focus"); } catch (e) { focusErr = String(e && e.message || e); }
    check(!focusErr, "the XScript activity-bar container and view can be opened", focusErr || undefined);
    await vscode.commands.executeCommand("xscript.screenshot");
    let tabs = [];
    for (let i = 0; i < 20; i++) { // the image editor opens asynchronously
      tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
      if (tabs.some((t) => /screen-\d+\.png$/.test(t.label || ""))) break;
      await sleep(500);
    }
    const png = tabs.find((t) => /screen-\d+\.png$/.test(t.label || ""));
    check(!!png, "screenshot opens a PNG editor tab", tabs.map((t) => t.label).join(","));

    // debugging through VS Code's own debug API: a real device, or the debugpy-backed mock (XS_HOST_TEST_DEBUG=1)
    if (real || process.env.XS_HOST_TEST_DEBUG === "1") {
      fs.writeFileSync(path.join(dir, "__init__.py"), "import time\nx = 1\ny = x + 1\nprint('dbg-done', y, flush=True)\ntime.sleep(1)\n");
      const uri = vscode.Uri.file(path.join(dir, "__init__.py"));
      const bp = new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(2, 0)));
      vscode.debug.addBreakpoints([bp]);
      const started = await vscode.debug.startDebugging(folder, { type: "xscript", request: "launch", name: "host test", projectRoot: dir });
      check(started === true, "debug session starts (xscript launch, uploads + starts with debugpy)");
      let item;
      for (let i = 0; i < 80 && !item; i++) { item = vscode.debug.activeStackItem; if (!item) await sleep(500); }
      const session = vscode.debug.activeDebugSession;
      check(!!item && !!session && session.type === "xscript", "execution stops at the breakpoint in VS Code", item ? String(item.frameId !== undefined ? "frame " + item.frameId : "thread " + item.threadId) : "no stack item");
      if (session) {
        const st = await session.customRequest("stackTrace", { threadId: item.threadId });
        const top = st.stackFrames && st.stackFrames[0];
        check(top && top.line === 3 && /__init__\.py$/.test(top.source && top.source.path || ""), "stack frame is mapped to the local file at line 3", top && (top.source && top.source.path) + ":" + top.line);
        const ev = await session.customRequest("evaluate", { expression: "x + 41", frameId: top.id, context: "repl" });
        check(ev && ev.result === "42", "debug console evaluates against the paused frame", ev && ev.result);
      }
      await vscode.debug.stopDebugging();
      vscode.debug.removeBreakpoints([bp]);
      await sleep(1500);
      st = (await http(base, "GET", "/status")).json;
      check(st.running === false, "stopping the debug session ends the device script");
    }
    await vscode.commands.executeCommand("xscript.removeDevice", { address: addr, name: "Renamed", quiet: true });
    check(!api.store.list().some((d) => d.address === addr), "removeDevice removes it");
  } finally {
    await http(base, "POST", "/projects/" + name + "/stop").catch(() => {});
    await http(base, "DELETE", "/projects/" + name).catch(() => {});
  }
}
