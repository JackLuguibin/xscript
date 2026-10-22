// Runs INSIDE the VS Code extension host (--extensionTestsPath): puts the editor into the states shown in the README
// screenshots (run + sidebar + log panel, debugger stopped at a breakpoint, the step-by-step connection check, the lost screen capture warning, the basic checks in the Problems panel, the Ctrl/Cmd+. import quick fix, the missing-permission warning after a run (accessibility, notification access, and Next after one fix); XS_SHOT_NAMES picks which), and for each one writes <XS_SHOT_DIR>/ready-<name> then waits for done-<name> (capture.js takes the
// picture through the DevTools protocol in between). Needs a real device: XS_SHOT_DEVICE=127.0.0.1:<forwarded port>.
const fs = require("fs");
const path = require("path");
const vscode = require("vscode");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = process.env.XS_SHOT_DIR;
const shot = async (name) => {
  fs.writeFileSync(path.join(dir, "ready-" + name), "");
  for (let i = 0; i < 120 && !fs.existsSync(path.join(dir, "done-" + name)); i++) await sleep(500);
};
async function http(base, method, route) {
  const r = await fetch(base + route, { method });
  try { return await r.json(); } catch { return {}; }
}

exports.run = async function run() {
  const addr = process.env.XS_SHOT_DEVICE;
  const base = "http://" + addr;
  const folder = vscode.workspace.workspaceFolders[0];
  const root = folder.uri.fsPath;
  const project = path.basename(root);
  const file = path.join(root, "__init__.py");
  const names = (process.env.XS_SHOT_NAMES || "run debug").split(/\s+/).filter(Boolean);
  try {
    const ext = vscode.extensions.getExtension("xscript.xscript-vscode");
    await ext.activate();
    await vscode.workspace.getConfiguration("xscript").update("device", addr, vscode.ConfigurationTarget.Workspace);
    await vscode.commands.executeCommand("xscript.addDevice", { name: "Android 模拟器", address: addr, quiet: true });
    await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
    const cmd = (c) => vscode.commands.executeCommand(c);
    await cmd("workbench.view.extension.xscript");
    await cmd("workbench.action.focusSideBar");
    for (let i = 0; i < 3; i++) await cmd("workbench.action.increaseViewSize");   // wide enough for the device row
    await sleep(1500);

    if (names.includes("connect")) {
      // the connection check on the configured address (XScript force-stopped on the device): steps in the output
      // channel, the notification says where it stopped; not awaited because the notification waits for a click
      void vscode.commands.executeCommand("xscript.checkConnection");
      await sleep(6000);
      await cmd("workbench.action.focusActiveEditorGroup");
      await sleep(800);
      await shot("connect");
      await cmd("notifications.clearAll");
    }

    if (process.env.XS_SHOT_PAIR === "1") {
      // the device asks for its pairing code: open the Pair input box, capture.js types the code into it
      void vscode.commands.executeCommand("xscript.pair");
      await sleep(1500);
      await shot("type-pair");
      await sleep(2500);
      await cmd("notifications.clearAll");
    }

    if (names.includes("capture")) {
      // the device's screen-recording grant is gone (force-stop XScript and reopen it, accessibility off): the status
      // bar warns, and its command asks whether to show the permission prompt on the phone
      await ext.exports.refreshStatus();
      void vscode.commands.executeCommand("xscript.grantCapture");
      await sleep(1500);
      await cmd("workbench.action.focusActiveEditorGroup");
      await sleep(800);
      await shot("capture");
      await cmd("notifications.clearAll");
    }

    if (names.includes("problems")) {
      // the Web IDE's basic checks in the Problems panel: a throw-away checks.py with typical slips, deleted afterwards
      const demo = path.join(root, "checks.py");
      fs.writeFileSync(demo, [
        "import os", "", "", "async def fetch_status():", "    return \"ok\"", "", "",
        "async def main():", "    total = 0", "    fetch_status()", "    print(totl)", "    return", "    print(\"done\")", "",
      ].join("\n"));
      await vscode.window.showTextDocument(vscode.Uri.file(demo), { preview: false });
      for (let i = 0; i < 20 && vscode.languages.getDiagnostics(vscode.Uri.file(demo)).length < 4; i++) await sleep(500);
      await cmd("workbench.actions.view.problems");
      await cmd("workbench.action.focusActiveEditorGroup");
      await sleep(1500);
      await shot("problems");
      await cmd("workbench.action.closeActiveEditor");
      fs.rmSync(demo, { force: true });
      await cmd("workbench.action.closePanel");
      await sleep(500);
    }

    if (names.includes("quickfix")) {
      // Ctrl/Cmd+. on an undefined name that another project module defines: the import quick fix (throw-away files)
      const util = path.join(root, "xs_util.py"), demo = path.join(root, "quickfix.py");
      fs.writeFileSync(util, "def wait_ready(seconds=1):\n    return True\n");
      fs.writeFileSync(demo, ["import os", "", "", "def main():", "    wait_ready(2)", "    print(os.name)", ""].join("\n"));
      const uri = vscode.Uri.file(demo);
      const ed = await vscode.window.showTextDocument(uri, { preview: false });
      for (let i = 0; i < 20 && !vscode.languages.getDiagnostics(uri).some((d) => d.source === "XScript"); i++) await sleep(500);
      ed.selection = new vscode.Selection(4, 6, 4, 6);
      await cmd("editor.action.quickFix");
      await sleep(1500);
      await shot("quickfix");
      await cmd("hideSuggestWidget");
      await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
      fs.rmSync(demo, { force: true });
      fs.rmSync(util, { force: true });
      await sleep(500);
    }

    for (const name of ["missing", "missing-notif", "missing-next", "missing-again"].filter((n) => names.includes(n))) {
      // a module using a permission the phone lacks (throw-away perm.py, deleted afterwards): after 运行 the warning offers
      // the one-tap fix. "missing": clicks with accessibility off; "missing-notif": listens to notifications without notification access; "missing-next": also reads /sdcard, the first fix is pressed and the follow-up offers Next; "missing-again": Next pressed too, Run Again offered and then pressed
      const demo = path.join(root, "perm.py");
      fs.writeFileSync(demo, name === "missing" ? "from xscript.android import node\n\nnode.Selector().text(\"签到\").exists(timeout=0)\n"
        : name === "missing-notif" ? "from xscript import event\n\nevent.on(\"notification\", print)\n"
        : "from xscript import event\n\nevent.on(\"notification\", print)\nprint(open(\"/sdcard/Download/x.txt\").read())\n");
      const press = async () => {
        await cmd("notifications.focusToasts");
        await cmd("notification.acceptPrimaryAction");
        await sleep(3000);
      };
      await vscode.commands.executeCommand("xscript.run", vscode.Uri.file(file));
      await sleep(4000);
      await cmd("workbench.action.focusActiveEditorGroup");
      await sleep(800);
      if (name === "missing-next" || name === "missing-again") {
        // press the warning's button (first fix): the follow-up says how many are left and offers Next;
        // "missing-again" also presses Next, so the last follow-up offers Run Again
        await press();
        if (name === "missing-again") await press();
        await cmd("workbench.action.focusActiveEditorGroup");
        await sleep(800);
      }
      await shot(name);
      if (name === "missing-again") {
        // Run Again starts the project on the phone a second time (the device log shows it)
        await press();
        await sleep(3000);
      }
      await cmd("notifications.clearAll");
      await vscode.commands.executeCommand("xscript.stop", vscode.Uri.file(file));
      fs.rmSync(demo, { force: true });
      await sleep(2500);
    }

    if (names.includes("run")) {
    // run: uploads, starts, streams the device log into the XScript output channel
    await vscode.commands.executeCommand("xscript.run", vscode.Uri.file(file));
    await sleep(4300);
    await ext.exports.refreshStatus();
    await cmd("xscript.refreshView");
    await cmd("workbench.action.focusActiveEditorGroup");
    await sleep(800);
    await shot("run");
    await vscode.commands.executeCommand("xscript.stop", vscode.Uri.file(file));
    await sleep(2500);
    }

    if (names.includes("debug")) {
    // debug: stop at the breakpoint on `total += i`
    const lines = fs.readFileSync(file, "utf8").split("\n");
    const at = lines.findIndex((l) => l.includes("total += i"));
    const bp = new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(file), new vscode.Position(at, 0)));
    vscode.debug.addBreakpoints([bp]);
    await vscode.debug.startDebugging(folder, { type: "xscript", request: "launch", name: "XScript: Debug Project", projectRoot: root });
    let item;
    for (let i = 0; i < 80 && !item; i++) { item = vscode.debug.activeStackItem; if (!item) await sleep(500); }
    await cmd("workbench.view.debug");
    await sleep(2500);
    // expand the paused thread's frames and the Locals scope so the picture shows real debugger state
    await cmd("workbench.debug.action.focusCallStackView");
    await cmd("list.focusFirst"); await cmd("list.focusDown"); await cmd("list.expand");
    await sleep(800);
    await cmd("workbench.debug.action.focusVariablesView");
    await cmd("list.focusFirst"); await cmd("list.expand");
    await sleep(800);
    await cmd("workbench.action.focusActiveEditorGroup");
    await sleep(1200);
    await shot("debug");
    await vscode.debug.stopDebugging();
    vscode.debug.removeBreakpoints([bp]);
    await sleep(1000);
    }
    fs.writeFileSync(path.join(dir, "result"), "ok");
  } catch (e) {
    fs.writeFileSync(path.join(dir, "result"), "error: " + (e && e.stack || e));
  } finally {
    await http(base, "POST", "/projects/" + project + "/stop").catch(() => {});
    await http(base, "DELETE", "/projects/" + project).catch(() => {});
    await vscode.commands.executeCommand("xscript.removeDevice", { address: addr, name: "Android 模拟器", quiet: true }).catch(() => {});
  }
};
