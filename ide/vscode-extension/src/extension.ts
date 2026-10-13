import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { DeviceClient, HttpError, parseTarget } from "./client";
import { collectFiles, findProjectRoot, isProjectDir } from "./project";

let client: DeviceClient;
let output: vscode.OutputChannel;
let statusItem: vscode.StatusBarItem;
let follow: { timer: NodeJS.Timeout; since: number; idle: number } | undefined;

function config() {
  return vscode.workspace.getConfiguration("xscript");
}

function makeClient(): DeviceClient {
  return new DeviceClient(parseTarget(config().get<string>("device", "127.0.0.1:9860")));
}

function describe(err: unknown): string {
  if (err instanceof HttpError) return err.message;
  const e = err as { name?: string; message?: string; cause?: { code?: string } };
  if (e?.name === "TimeoutError") return "timed out";
  if (e?.cause?.code) return e.cause.code; // ECONNREFUSED etc.
  return e?.message ?? String(err);
}

async function guard<T>(what: string, fn: () => PromiseLike<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    const msg = "XScript: " + what + " failed (" + describe(err) + ") at " + client.baseUrl;
    output.appendLine(msg);
    const pick = await vscode.window.showErrorMessage(msg, "Change Device");
    if (pick) await vscode.commands.executeCommand("xscript.connect");
    return undefined;
  } finally {
    void refreshStatus();
  }
}

async function refreshStatus(): Promise<void> {
  const addr = client.target.host + ":" + client.target.port;
  try {
    const s = await client.status(3000);
    const running = s.running ? " $(play) " + String(s.project ?? "") : "";
    statusItem.text = "$(device-mobile) " + String(s.model || s.name || "XScript") + running;
    statusItem.tooltip = "XScript device " + addr + " (click to change)";
  } catch {
    statusItem.text = "$(debug-disconnect) XScript";
    statusItem.tooltip = "XScript device " + addr + " is not reachable (click to change)";
  }
}

/** The project for a command: explorer folder, else the active file's project, else ask. */
async function resolveProject(uri?: vscode.Uri): Promise<string | undefined> {
  const candidates: string[] = [];
  if (uri?.scheme === "file") candidates.push(uri.fsPath);
  const doc = vscode.window.activeTextEditor?.document;
  if (doc?.uri.scheme === "file") candidates.push(doc.uri.fsPath);
  for (const c of candidates) {
    const boundary = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(c))?.uri.fsPath;
    const root = findProjectRoot(c, boundary);
    if (root) return root;
  }
  const picked = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    openLabel: "Use as XScript project",
  });
  const dir = picked?.[0]?.fsPath;
  if (dir && !isProjectDir(dir)) {
    vscode.window.showErrorMessage("XScript: " + dir + " has no __init__.py");
    return undefined;
  }
  return dir;
}

async function upload(root: string): Promise<boolean> {
  const name = path.basename(root);
  await vscode.workspace.saveAll(false);
  const files = collectFiles(root);
  const res = await guard("upload", () =>
    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "XScript: uploading " + name },
      () => client.uploadFiles(name, files),
    ),
  );
  if (!res) return false;
  output.appendLine("uploaded " + name + " (" + files.length + " files) to " + client.baseUrl);
  return true;
}

function stopFollowing(): void {
  if (follow) clearInterval(follow.timer);
  follow = undefined;
}

async function startFollowing(since: number): Promise<void> {
  stopFollowing();
  const ms = Math.max(200, config().get<number>("logPollMs", 1000));
  const state = { since, idle: 0, timer: setInterval(() => void tick(), ms) };
  follow = state;
  let busy = false;
  async function tick() {
    if (busy || follow !== state) return;
    busy = true;
    try {
      const r = await client.logs(state.since);
      for (const e of r.entries) output.append(e.line.endsWith("\n") ? e.line : e.line + "\n");
      state.since = r.next ?? state.since;
      state.idle = r.entries.length ? 0 : state.idle + 1;
      // Every few quiet polls, stop once the script has exited.
      if (state.idle > 0 && state.idle % 3 === 0) {
        const s = await client.status(3000);
        if (!s.running) {
          output.appendLine("[xscript] script finished");
          stopFollowing();
          void refreshStatus();
        }
      }
    } catch (err) {
      output.appendLine("[xscript] log polling stopped: " + describe(err));
      stopFollowing();
    } finally {
      busy = false;
    }
  }
}

/** Latest log seq, so following shows only lines from the next run. */
async function currentSeq(): Promise<number> {
  let since = 0;
  for (let i = 0; i < 100; i++) {
    const r = await client.logs(since);
    if (!r.entries.length || r.next === since) break;
    since = r.next;
  }
  return since;
}

const commands: Record<string, (...args: any[]) => unknown> = {
  "xscript.connect": async () => {
    const value = await vscode.window.showInputBox({
      prompt: "Device address shown in the app (开发者地址)",
      value: config().get<string>("device", "127.0.0.1:9860"),
      validateInput: (v) => {
        try {
          parseTarget(v);
          return undefined;
        } catch (e) {
          return (e as Error).message;
        }
      },
    });
    if (value === undefined) return;
    const target = vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
    await config().update("device", value.trim(), target);
    const s = await guard("connect", () => client.status(5000));
    if (s) vscode.window.showInformationMessage("XScript: connected to " + String(s.model || s.name) + " at " + client.baseUrl);
  },

  "xscript.status": async () => {
    const s = await guard("status", () => client.status());
    if (!s) return;
    output.appendLine(JSON.stringify(s, null, 2));
    output.show(true);
  },

  "xscript.upload": async (uri?: vscode.Uri) => {
    const root = await resolveProject(uri);
    if (root && (await upload(root))) vscode.window.showInformationMessage("XScript: uploaded " + path.basename(root));
  },

  "xscript.run": async (uri?: vscode.Uri) => {
    const root = await resolveProject(uri);
    if (!root || !(await upload(root))) return;
    const name = path.basename(root);
    const since = (await guard("read logs", currentSeq)) ?? 0;
    const r = await guard("run", () => client.run(name));
    if (!r) return;
    if (r.error) {
      vscode.window.showWarningMessage("XScript: " + String(r.error) + (r.project ? " (" + String(r.project) + ")" : ""));
      return;
    }
    output.show(true);
    output.appendLine("[xscript] running " + name);
    await startFollowing(since);
  },

  "xscript.stop": async (uri?: vscode.Uri) => {
    const s = await guard("status", () => client.status());
    if (!s) return;
    let name = s.project ? String(s.project) : "";
    if (!name) {
      const root = await resolveProject(uri);
      if (!root) return;
      name = path.basename(root);
    }
    if (await guard("stop", () => client.stop(name))) output.appendLine("[xscript] stopped " + name);
  },

  "xscript.logs": async () => {
    if (follow) {
      stopFollowing();
      output.appendLine("[xscript] stopped following logs");
      return;
    }
    output.show(true);
    await startFollowing(0);
  },

  "xscript.eval": async () => {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return;
    const code = ed.selection.isEmpty ? ed.document.lineAt(ed.selection.active.line).text : ed.document.getText(ed.selection);
    if (!code.trim()) return;
    const timeout = config().get<number>("evalTimeoutMs", 8000);
    const r = await guard("eval", () => client.eval(code, timeout));
    if (!r) return;
    output.show(true);
    output.appendLine(">>> " + code.split("\n").join("\n... "));
    output.appendLine(r.ok ? String(r.result ?? "") : "error: " + String(r.error ?? ""));
  },

  "xscript.screenshot": async (ctx: vscode.ExtensionContext) => {
    const png = await guard("screenshot", () => client.screenPng());
    if (!png) return;
    const dir = ctx.globalStorageUri.fsPath;
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "screen-" + Date.now() + ".png");
    fs.writeFileSync(file, png);
    await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(file), { preview: true });
  },

  "xscript.openTools": async () => {
    await vscode.env.openExternal(vscode.Uri.parse(client.baseUrl + "/tools/"));
  },

  "xscript.configureStubs": async (ctx: vscode.ExtensionContext) => {
    const stubs = path.join(ctx.extensionPath, "stubs");
    if (!fs.existsSync(stubs)) {
      vscode.window.showErrorMessage("XScript: bundled stubs are missing; rebuild the extension (npm run compile)");
      return;
    }
    // Pylance / Pyright and Cursor's Python extension both read python.analysis.extraPaths.
    const py = vscode.workspace.getConfiguration("python.analysis");
    const paths = (py.get<string[]>("extraPaths") ?? []).filter((p) => !p.includes("xscript") || p === stubs);
    if (!paths.includes(stubs)) paths.push(stubs);
    await py.update("extraPaths", paths, vscode.ConfigurationTarget.Workspace);
    vscode.window.showInformationMessage("XScript: autocomplete enabled for xscript.* and ascript.*");
  },
};

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("XScript");
  client = makeClient();
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusItem.command = "xscript.connect";
  statusItem.show();
  context.subscriptions.push(output, statusItem, { dispose: stopFollowing });

  const needsContext = new Set(["xscript.screenshot", "xscript.configureStubs"]);
  for (const [id, fn] of Object.entries(commands)) {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, (...args: unknown[]) => (needsContext.has(id) ? fn(context) : fn(...args))),
    );
  }
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("xscript.device")) {
        client = makeClient();
        void refreshStatus();
      }
    }),
  );
  // The app shows "AI 编程连接" for 90 s after the last request; a light status poll keeps it current.
  const poll = setInterval(() => void refreshStatus(), 30000);
  context.subscriptions.push({ dispose: () => clearInterval(poll) });
  void refreshStatus();
}

export function deactivate(): void {
  stopFollowing();
}
