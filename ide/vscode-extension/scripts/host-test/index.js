// Runs INSIDE the Cursor / VS Code extension host (launched with --extensionTestsPath, see scripts/cursor-host-test.sh):
// checks that the installed vsix activates and registers its commands, debugger type, keybindings and menus.
// Results go to $XS_HOST_TEST_OUT as JSON (the editor swallows stdout).
const fs = require("fs");
const vscode = require("vscode");

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
      check(want.length >= 11 && missing.length === 0, `all ${want.length} contributed commands are registered`, missing.join(",") || undefined);
      check((pj.contributes.debuggers || []).some((d) => d.type === "xscript"), "debugger type xscript contributed");
      check((pj.contributes.keybindings || []).some((k) => k.command === "xscript.debug" && k.key === "alt+f6"), "Alt+F6 keybinding for debug");
      // a command that needs no device: it should run (and report an error toast at most), never be "not found"
      let threw = "";
      try { await Promise.race([vscode.commands.executeCommand("xscript.status"), new Promise((r) => setTimeout(r, 4000))]); } catch (e) { threw = String(e && e.message || e); }
      check(!/not found/i.test(threw), "xscript.status executes (no 'command not found')", threw || undefined);
      // debug configuration provider resolves a bare config
      const folder = (vscode.workspace.workspaceFolders || [])[0];
      check(!!folder, "workspace folder with __init__.py is open", folder && folder.uri.fsPath);
      const py = await vscode.workspace.findFiles("**/__init__.py", null, 1);
      check(py.length === 1, "workspaceContains:**/__init__.py found the project file");
    }
  } catch (e) {
    check(false, "host test threw", String(e && e.stack || e));
  }
  if (out) fs.writeFileSync(out, JSON.stringify(checks, null, 2));
  if (checks.some((c) => !c.ok)) throw new Error("host checks failed: " + checks.filter((c) => !c.ok).map((c) => c.what).join("; "));
};
