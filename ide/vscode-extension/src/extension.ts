import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { DeviceClient, DeviceTarget, currentSeq as latestSeq, describeError, followTick, isPairingError, normalizeCode, parseTarget, validateCode } from "./client";
import type { RemoteFile } from "./client";
import { collectFiles, findProjectRoot, isProjectDir, isSyncedPath } from "./project";
import { registerDebugger, startDebugging } from "./debugAdapter";
import { execFile } from "child_process";
import { DeviceStore, FoundDevice, SavedDevice, httpProbe, lanCandidates, normalizeAddress, scanAdb, scanLan } from "./devices";
import { DEFAULT_SYNCIGNORE, IgnoreRules, SYNCIGNORE_PATH, SyncCache, describeDeletes, planEmptiedFolders, diffAgainstLocal, fetchProject, loadIgnoreRules, planDeletes, planUpload, writePulled } from "./sync";
import { TEMPLATES, createProject, validateProjectName } from "./newProject";
import { Node, XScriptTree } from "./tree";
import { newUiForm, registerUiDesigner } from "./uiDesigner";

let client: DeviceClient;
let output: vscode.OutputChannel;
let statusItem: vscode.StatusBarItem;
let follow: { timer: NodeJS.Timeout; since: number; idle: number } | undefined;
let extCtx: vscode.ExtensionContext;
let store: DeviceStore;
let tree: XScriptTree;
let isRunning = false;

function config() {
  return vscode.workspace.getConfiguration("xscript");
}

// Pairing codes per device address ("host:port"), kept in VS Code's SecretStorage (OS keychain).
const PAIRING_SECRET = "xscript.pairing";
let pairing: Record<string, string> = {};

function addressOf(t: DeviceTarget): string {
  return (t.host.includes(":") ? "[" + t.host + "]" : t.host) + ":" + t.port;
}

function tokenFor(t: DeviceTarget): string {
  return pairing[addressOf(t)] ?? "";
}

async function loadPairing(): Promise<void> {
  try {
    const raw = await extCtx.secrets.get(PAIRING_SECRET);
    pairing = raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    pairing = {};
  }
}

async function savePairing(t: DeviceTarget, code: string): Promise<void> {
  if (code) pairing[addressOf(t)] = code;
  else delete pairing[addressOf(t)];
  await extCtx.secrets.store(PAIRING_SECRET, JSON.stringify(pairing));
}

function deviceClient(t: DeviceTarget, timeoutMs?: number): DeviceClient {
  return new DeviceClient(t, timeoutMs, tokenFor(t));
}

function makeClient(): DeviceClient {
  return deviceClient(parseTarget(config().get<string>("device", "127.0.0.1:9860")));
}

/**
 * Asks for the pairing code shown on the phone and checks it against the device. True once paired
 * (or when the device has pairing switched off).
 */
async function pairDevice(): Promise<boolean> {
  const t = client.target;
  const code = await vscode.window.showInputBox({
    title: "XScript: Pair with " + addressOf(t),
    prompt: "Pairing code shown in the XScript app (开发与连接 → 配对码)",
    placeHolder: "ABCD-EFGH",
    ignoreFocusOut: true,
    validateInput: validateCode,
  });
  if (code === undefined) return false;
  const probe = new DeviceClient(t, 5000, normalizeCode(code));
  try {
    await probe.listProjects();
  } catch (err) {
    vscode.window.showErrorMessage(
      isPairingError(err) ? "XScript: wrong pairing code for " + addressOf(t) : "XScript: pairing failed (" + describe(err) + ")",
    );
    return false;
  }
  await savePairing(t, normalizeCode(code));
  client.token = normalizeCode(code);
  tree?.refresh();
  void refreshStatus();
  vscode.window.showInformationMessage("XScript: paired with " + addressOf(t));
  return true;
}

const describe = describeError;

async function guard<T>(what: string, fn: () => PromiseLike<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    if (isPairingError(err)) {
      output.appendLine("XScript: " + what + " needs pairing with " + client.baseUrl);
      const pick = await vscode.window.showWarningMessage(
        "XScript: " + addressOf(client.target) + " needs the pairing code shown in the app (开发与连接 → 配对码).",
        "Enter Pairing Code",
      );
      if (pick && (await pairDevice())) {
        try {
          return await fn();
        } catch (again) {
          err = again;
        }
      } else {
        return undefined;
      }
    }
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
    isRunning = !!s.running;
    void vscode.commands.executeCommand("setContext", "xscript.running", isRunning);
    if (s.pairing && !s.paired) {
      isRunning = false;
      void vscode.commands.executeCommand("setContext", "xscript.running", false);
      statusItem.text = "$(lock) XScript: pair " + String(s.model || s.name || "device");
      statusItem.tooltip = "XScript device " + addr + " needs the pairing code (click to pair)";
      statusItem.command = "xscript.pair";
      return;
    }
    statusItem.command = "xscript.connect";
    const running = s.running ? " $(play) " + String(s.project ?? "") : "";
    statusItem.text = "$(device-mobile) " + String(s.model || s.name || "XScript") + running;
    statusItem.tooltip = "XScript device " + addr + " (click to change)";
  } catch {
    isRunning = false;
    void vscode.commands.executeCommand("setContext", "xscript.running", false);
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

/**
 * Sends the project to the device. Unless `full`, only files that are new or changed since the last upload from
 * here are sent (the device's file list is compared by size, our cache by content hash); `.vscode/.syncignore`
 * applies either way.
 */
async function upload(root: string, full = true): Promise<boolean> {
  const name = path.basename(root);
  await vscode.workspace.saveAll(false);
  const ignore = loadIgnoreRules(root);
  const files = collectFiles(root, ignore);
  const syncDeletes = config().get<boolean>("syncDeletes", false);
  let remoteList: RemoteFile[] | undefined;
  const key = "sync:" + client.target.host + ":" + client.target.port + ":" + name;
  const plan = await guard("upload", () =>
    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "XScript: uploading " + name },
      async () => {
        const remote = full && !syncDeletes ? undefined : await client.projectFiles(name);
        remoteList = remote;
        const p = planUpload(files, full ? undefined : remote, full ? {} : extCtx.workspaceState.get<SyncCache>(key, {}));
        if (p.upload.length || !remote) await client.uploadFiles(name, p.upload);
        await extCtx.workspaceState.update(key, p.hashes);
        return p;
      },
    ),
  );
  if (!plan) return false;
  output.appendLine(
    "uploaded " + name + " to " + client.baseUrl + ": " + plan.upload.length + " file(s) sent" + (plan.skipped ? ", " + plan.skipped + " unchanged" : ""),
  );
  if (syncDeletes) await deleteRemoved(name, files.map((f) => f.path), remoteList, ignore);
  return true;
}

/**
 * `xscript.syncDeletes` (off by default): device files that are not in the local project and that an upload manages
 * (.syncignore'd and skipped paths are never touched) are listed in a modal and deleted only when confirmed.
 */
async function deleteRemoved(name: string, local: string[], remote: RemoteFile[] | undefined, ignore: IgnoreRules): Promise<void> {
  const gone = planDeletes(local, remote, (rel) => isSyncedPath(rel, ignore));
  if (!gone.length) return;
  const folders = planEmptiedFolders(local, remote, gone);
  const ok = "Delete " + gone.length + " on Device";
  const detail = describeDeletes(gone) + (folders.length ? "\n\nFolders left empty, removed with anything still in them (such as __pycache__):\n" + describeDeletes(folders.map((d) => d + "/")) : "");
  const pick = await vscode.window.showWarningMessage(
    "XScript: " + gone.length + " file(s) of \"" + name + "\" are on the device but no longer in your local project. Delete them on the device" +
      (folders.length ? ", and the " + folders.length + " folder(s) they leave empty" : "") + "? This cannot be undone.",
    { modal: true, detail },
    ok,
  );
  if (pick !== ok) {
    output.appendLine("kept " + gone.length + " file(s) on the device that are not in the local project");
    return;
  }
  const failed: string[] = [];
  for (const p of gone) {
    try {
      if (!(await client.deleteFile(name, p))) failed.push(p);
    } catch {
      failed.push(p);
    }
  }
  let removed = 0;
  for (const d of folders) {
    // A folder whose file could not be deleted is not empty: leave it.
    if (failed.some((f) => f.startsWith(d + "/"))) continue;
    try {
      await client.deleteFolder(name, d);
      removed++;
    } catch {
      failed.push(d + "/");
    }
  }
  output.appendLine(
    "deleted " + (gone.length - failed.filter((f) => !f.endsWith("/")).length) + " file(s) on the device that were removed locally" +
      (removed ? " and " + removed + " emptied folder(s)" : "") + (failed.length ? "; could not delete: " + failed.join(", ") : ""),
  );
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
      if ((await followTick(client, state, (text) => output.append(text))) === "done") {
        output.appendLine("[xscript] script finished");
        stopFollowing();
        void refreshStatus();
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
function currentSeq(): Promise<number> {
  return latestSeq(client);
}

// ---------------------------------------------------------------- devices

function currentAddress(): string {
  return normalizeAddress(config().get<string>("device", "127.0.0.1:9860"));
}

/** Points the device commands at `d` (workspace setting, like AScript's per-project device in .vscode/settings.json). */
async function useDevice(d: SavedDevice): Promise<void> {
  const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  await config().update("device", d.address, target);
  client = makeClient();
  await refreshStatus();
  tree?.refresh();
}

function adbPath(): string {
  const set = config().get<string>("adbPath", "").trim();
  if (set) return set;
  const roots = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, path.join(process.env.HOME || "", "Library/Android/sdk"), path.join(process.env.HOME || "", "Android/Sdk")];
  for (const r of roots) {
    if (!r) continue;
    const p = path.join(r, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb");
    if (fs.existsSync(p)) return p;
  }
  return "adb";
}

function runCmd(cmd: string, args: string[]): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 8000 }, (err, stdout) => {
      resolve({ stdout: String(stdout ?? ""), code: err ? ((err as { code?: number }).code ?? 1) || 1 : 0 });
    });
  });
}

async function deviceFromArg(arg: unknown): Promise<SavedDevice | undefined> {
  if (arg instanceof Node && arg.device) return arg.device;
  if (arg && typeof arg === "object" && typeof (arg as SavedDevice).address === "string") return arg as SavedDevice;
  return undefined;
}

async function pickDevice(placeholder: string, withActions: boolean): Promise<SavedDevice | "scan" | "add" | undefined> {
  type Item = vscode.QuickPickItem & { dev?: SavedDevice; action?: "scan" | "add" };
  const cur = currentAddress();
  const items: Item[] = store.list().map((d) => ({
    label: (d.address === cur ? "$(check) " : "$(device-mobile) ") + d.name,
    description: d.address,
    dev: d,
  }));
  if (!items.some((i) => i.dev?.address === cur)) items.unshift({ label: "$(check) " + cur, description: "current setting", dev: { name: cur, address: cur } });
  if (withActions) {
    items.push({ label: "$(search) Scan devices…", action: "scan" }, { label: "$(add) Add device…", action: "add" });
  }
  const pick = await vscode.window.showQuickPick(items, { placeHolder: placeholder, matchOnDescription: true });
  return pick ? pick.dev ?? pick.action : undefined;
}

async function addDevice(arg?: { name?: string; address?: string; quiet?: boolean }): Promise<SavedDevice | undefined> {
  let address = arg?.address;
  if (address === undefined) {
    address = await vscode.window.showInputBox({
      prompt: "Device address shown in the app (开发者地址), e.g. 192.168.1.20 or 192.168.1.20:9860",
      validateInput: (v) => {
        try { parseTarget(v); return v.trim() ? undefined : "Enter an address"; } catch (e) { return (e as Error).message; }
      },
    });
    if (address === undefined) return undefined;
  }
  const addr = normalizeAddress(address);
  const t = parseTarget(addr);
  const found = await httpProbe(2500)(t.host, t.port);
  if (!found && !arg?.quiet) {
    const pick = await vscode.window.showWarningMessage("XScript: " + addr + " did not answer. Save it anyway?", "Save", "Cancel");
    if (pick !== "Save") return undefined;
  }
  let name = arg?.name;
  if (name === undefined) {
    name = await vscode.window.showInputBox({ prompt: "Name for this device", value: found?.model || found?.name || addr });
    if (name === undefined) return undefined;
  }
  await store.add({ name, address: addr });
  tree?.refresh();
  return { name: name || addr, address: addr };
}

async function scanDevices(arg?: { hosts?: string[]; adb?: boolean; lan?: boolean }): Promise<FoundDevice[]> {
  const useAdb = arg?.adb ?? true;
  const useLan = arg?.lan ?? config().get<boolean>("scanLan", true);
  const found = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "XScript: scanning for devices" },
    async (progress) => {
      const all: FoundDevice[] = [];
      if (useAdb) {
        progress.report({ message: "ADB (USB / emulators)" });
        all.push(...(await scanAdb(adbPath(), runCmd, httpProbe(1500))));
      }
      if (useLan) {
        const hosts = arg?.hosts ?? lanCandidates();
        let last = 0;
        const lan = await scanLan(hosts, httpProbe(600), {
          onProgress: (done, total) => {
            const pct = Math.floor((done / total) * 100);
            if (pct > last) { progress.report({ message: "local network " + pct + "%", increment: pct - last }); last = pct; }
          },
        });
        for (const d of lan) if (!all.some((a) => a.model && a.model === d.model && d.address.startsWith("127."))) all.push(d);
      }
      return all;
    },
  );
  const added = await store.merge(found);
  tree?.refresh();
  output.appendLine("[xscript] scan found " + found.length + " device(s): " + (found.map((d) => d.name + " " + d.address).join(", ") || "none"));
  if (!arg) {
    vscode.window.showInformationMessage(
      found.length ? "XScript: found " + found.length + " device(s), " + added + " new. Pick one in the XScript side bar." : "XScript: no device found. Is the app running (开发者 → 开发者地址)? For USB, enable USB debugging.",
    );
  }
  return found;
}

async function manageDevices(): Promise<void> {
  const pick = await pickDevice("Manage devices", true);
  if (pick === "scan") return void (await scanDevices());
  if (pick === "add") return void (await addDevice());
  if (!pick) return;
  const act = await vscode.window.showQuickPick(["Use this device", "Rename / change address", "Remove from list"], { placeHolder: pick.name + " — " + pick.address });
  if (act === "Use this device") await useDevice(pick);
  else if (act === "Rename / change address") await commands["xscript.editDevice"](pick);
  else if (act === "Remove from list") await commands["xscript.removeDevice"](pick);
}

// ---------------------------------------------------------------- projects: new, pull, sync

async function newProject(arg?: { parent?: string; name?: string; template?: string; open?: boolean }): Promise<string | undefined> {
  const tpl = arg?.template
    ? TEMPLATES.find((t) => t.id === arg.template)
    : (await vscode.window.showQuickPick(TEMPLATES.map((t) => ({ label: t.label, description: t.detail, t })), { placeHolder: "Project template" }))?.t;
  if (!tpl) return undefined;
  const name =
    arg?.name ?? (await vscode.window.showInputBox({ prompt: "Project name (also its name on the device)", validateInput: validateProjectName }));
  if (!name) return undefined;
  let parent = arg?.parent;
  if (!parent) {
    const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: "Create project here" });
    parent = picked?.[0]?.fsPath;
  }
  if (!parent) return undefined;
  let dir: string;
  try {
    dir = createProject(parent, name, tpl);
  } catch (e) {
    vscode.window.showErrorMessage("XScript: " + (e as Error).message);
    return undefined;
  }
  output.appendLine("[xscript] created project " + dir + " (" + tpl.id + ")");
  if (arg?.open === false) return dir;
  const pick = await vscode.window.showInformationMessage("XScript: created " + name, "Open in New Window", "Open Here");
  if (pick) await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(dir), { forceNewWindow: pick === "Open in New Window" });
  return dir;
}

async function pullProject(arg?: unknown): Promise<{ written: number; added: string[]; changed: string[]; dest: string } | undefined> {
  const a = (arg && !(arg instanceof Node) ? arg : {}) as { project?: string; dest?: string; overwrite?: boolean };
  let project = arg instanceof Node ? arg.project : a.project;
  if (!project) {
    const names = await guard("list projects", () => client.listProjects());
    if (!names) return undefined;
    if (!names.length) return void vscode.window.showInformationMessage("XScript: the device has no projects yet");
    project = await vscode.window.showQuickPick(names, { placeHolder: "Project to pull from " + client.baseUrl });
    if (!project) return undefined;
  }
  let dest = a.dest;
  if (!dest) {
    const open = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath).find((p) => path.basename(p) === project && isProjectDir(p));
    if (open) dest = open;
    else {
      const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: "Pull into a new folder here" });
      if (!picked?.[0]) return undefined;
      dest = path.join(picked[0].fsPath, project);
    }
  }
  const name = project;
  const pulled = await guard("pull", () =>
    vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "XScript: pulling " + name }, () => fetchProject(client, name)),
  );
  if (!pulled) return undefined;
  const diff = diffAgainstLocal(dest, pulled);
  if (diff.changed.length && !a.overwrite) {
    const pick = await vscode.window.showWarningMessage(
      "XScript: " + diff.changed.length + " local file(s) differ from the device and will be overwritten (" + diff.changed.slice(0, 3).join(", ") + (diff.changed.length > 3 ? ", …" : "") + ").",
      { modal: true },
      "Overwrite",
    );
    if (pick !== "Overwrite") return undefined;
  }
  const written = writePulled(dest, pulled, diff);
  output.appendLine("[xscript] pulled " + name + " into " + dest + ": " + diff.added.length + " new, " + diff.changed.length + " updated, " + diff.unchanged.length + " unchanged");
  if (a.dest === undefined) {
    const pick = await vscode.window.showInformationMessage("XScript: pulled " + name + " (" + written + " file(s) written)", "Open Folder");
    if (pick) await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(dest), { forceNewWindow: false });
  }
  return { written, added: diff.added, changed: diff.changed, dest };
}

async function adbTerminal(): Promise<void> {
  const adb = adbPath();
  const list = (await runCmd(adb, ["devices"])).stdout;
  const serials = list.split(/\r?\n/).slice(1).map((l) => l.trim().split(/\s+/)).filter((p) => p[1] === "device").map((p) => p[0]);
  if (!serials.length) return void vscode.window.showWarningMessage("XScript: no USB / emulator device is visible to adb (" + adb + ")");
  const port = String(parseTarget(currentAddress()).port);
  const fwd = (await runCmd(adb, ["forward", "--list"])).stdout.split(/\r?\n/).map((l) => l.trim().split(/\s+/)).find((p) => p[1] === "tcp:" + port && serials.includes(p[0]));
  let serial = fwd?.[0] ?? (serials.length === 1 ? serials[0] : undefined);
  if (!serial) serial = await vscode.window.showQuickPick(serials, { placeHolder: "adb device" });
  if (!serial) return;
  vscode.window.createTerminal({ name: "adb shell " + serial, shellPath: adb, shellArgs: ["-s", serial, "shell"] }).show();
}

/** Starts an uploaded project and follows its logs. */
async function startRun(name: string): Promise<void> {
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
    client = makeClient();
    const s = await guard("connect", () => client.status(5000));
    if (s) {
      await store.merge([{ name: String(s.model || s.name || value.trim()), address: normalizeAddress(value) }]);
      tree?.refresh();
      vscode.window.showInformationMessage("XScript: connected to " + String(s.model || s.name) + " at " + client.baseUrl);
    }
  },

  "xscript.pair": () => pairDevice(),

  "xscript.newUiForm": (arg?: { root?: string; name?: string }) => newUiForm(arg),

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
    if (!root) return;
    const name = path.basename(root);
    // Like AScript: running again stops the current run first, then syncs and starts.
    const st = await guard("status", () => client.status());
    if (!st) return;
    if (st.running) {
      const busy = String(st.project || name);
      output.appendLine("[xscript] stopping " + busy + " before the re-run");
      if (!(await guard("stop", () => client.stop(busy)))) return;
      for (let i = 0; i < 20; i++) {
        const now = await client.status(3000).catch(() => st);
        if (!now.running) break;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    if (!(await upload(root, false))) return;
    await startRun(name);
  },

  "xscript.debug": async (uri?: vscode.Uri) => {
    const root = await resolveProject(uri);
    if (!root) return;
    output.show(true);
    if (!(await startDebugging(root))) vscode.window.showWarningMessage("XScript: the debug session did not start (see the XScript output)");
  },

  "xscript.stop": async (uri?: vscode.Uri | Node) => {
    if (uri instanceof Node && uri.device) await useDevice(uri.device);
    const s = await guard("status", () => client.status());
    if (!s) return;
    let name = s.project ? String(s.project) : "";
    if (!name) {
      const root = await resolveProject(uri instanceof Node ? undefined : uri);
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

  "xscript.selectDevice": async () => {
    const pick = await pickDevice("Select the device to run on", true);
    if (pick === "scan") await scanDevices();
    else if (pick === "add") {
      const d = await addDevice();
      if (d) await useDevice(d);
    } else if (pick) await useDevice(pick);
  },

  "xscript.useDevice": async (arg?: unknown) => {
    const d = await deviceFromArg(arg);
    if (d) await useDevice(d);
  },

  "xscript.runOnDevice": async (arg?: unknown) => {
    const d = await deviceFromArg(arg);
    if (d) await useDevice(d);
    await vscode.commands.executeCommand("xscript.run");
  },

  "xscript.runRemote": async (arg?: unknown) => {
    const name = arg instanceof Node ? arg.project : undefined;
    if (!name) return;
    await startRun(name);
  },

  "xscript.addDevice": (arg?: { name?: string; address?: string; quiet?: boolean }) => addDevice(arg && !(arg instanceof Node) ? arg : undefined),
  "xscript.editDevice": async (arg?: unknown) => {
    const d = (await deviceFromArg(arg)) ?? ((await pickDevice("Device to edit", false)) as SavedDevice | undefined);
    if (!d || typeof d === "string") return;
    const a = arg as { newName?: string; newAddress?: string } | undefined;
    const name = a?.newName ?? (await vscode.window.showInputBox({ prompt: "Name", value: d.name }));
    if (name === undefined) return;
    const address = a?.newAddress ?? (await vscode.window.showInputBox({ prompt: "Address (开发者地址)", value: d.address, validateInput: (v) => { try { parseTarget(v); return undefined; } catch (e) { return (e as Error).message; } } }));
    if (address === undefined) return;
    await store.edit(d.address, { name, address });
    tree.refresh();
  },
  "xscript.removeDevice": async (arg?: unknown) => {
    const d = (await deviceFromArg(arg)) ?? ((await pickDevice("Device to remove", false)) as SavedDevice | undefined);
    if (!d || typeof d === "string") return;
    const quiet = !!(arg && typeof arg === "object" && (arg as { quiet?: boolean }).quiet);
    if (!quiet && (await vscode.window.showWarningMessage("XScript: remove " + d.name + " (" + d.address + ") from the list?", { modal: true }, "Remove")) !== "Remove") return;
    await store.remove(d.address);
    tree.refresh();
  },
  "xscript.manageDevices": () => manageDevices(),
  "xscript.scanDevices": (arg?: { hosts?: string[]; adb?: boolean; lan?: boolean }) => scanDevices(arg && !(arg instanceof Node) ? arg : undefined),
  "xscript.newProject": (arg?: object) =>
    newProject(arg && !(arg instanceof Node) && "parent" in arg ? (arg as { parent?: string; name?: string; template?: string; open?: boolean }) : undefined),
  "xscript.pullProject": (arg?: unknown) => pullProject(arg),
  "xscript.syncManage": async () => {
    const pick = await vscode.window.showQuickPick(
      [{ label: "$(cloud-upload) Push the current project to the device", id: "push" }, { label: "$(cloud-download) Pull a project from the device", id: "pull" }],
      { placeHolder: "Sync with " + client.baseUrl },
    );
    if (pick?.id === "push") await vscode.commands.executeCommand("xscript.upload");
    else if (pick?.id === "pull") await pullProject();
  },
  "xscript.editSyncIgnore": async (uri?: vscode.Uri) => {
    const root = await resolveProject(uri instanceof vscode.Uri ? uri : undefined);
    if (!root) return;
    const file = path.join(root, SYNCIGNORE_PATH);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, DEFAULT_SYNCIGNORE, "utf-8");
    }
    await vscode.window.showTextDocument(vscode.Uri.file(file));
  },
  "xscript.adbTerminal": () => adbTerminal(),
  "xscript.openScreen": async () => {
    await vscode.env.openExternal(vscode.Uri.parse(client.baseUrl + "/website/src/screen.html"));
  },
  "xscript.refreshView": () => {
    tree.refresh();
    void refreshStatus();
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

async function updateProjectContext(): Promise<void> {
  let found = (vscode.workspace.workspaceFolders ?? []).some((f) => isProjectDir(f.uri.fsPath));
  if (!found && vscode.workspace.workspaceFolders?.length) {
    found = (await vscode.workspace.findFiles("**/{__init__.py,build.as}", "**/{node_modules,.venv,venv}/**", 1)).length > 0;
  }
  await vscode.commands.executeCommand("setContext", "xscript.isProject", found);
}

export interface XScriptApi {
  store: DeviceStore;
  tree: XScriptTree;
  refreshStatus: () => Promise<void>;
  /** Text of the status bar item (for the extension-host test). */
  statusText: () => string;
}

export function activate(context: vscode.ExtensionContext): XScriptApi {
  extCtx = context;
  output = vscode.window.createOutputChannel("XScript");
  client = makeClient();
  store = new DeviceStore(context.globalState);
  tree = new XScriptTree({
    store,
    currentAddress,
    probe: async (address) => {
      const t = parseTarget(address);
      try {
        const s = await deviceClient(t, 1500).status(1500);
        return { online: true, running: !!s.running, project: s.project ? String(s.project) : undefined, model: s.model ? String(s.model) : undefined };
      } catch {
        return { online: false, running: false };
      }
    },
    listProjects: (address) => deviceClient(parseTarget(address), 3000).listProjects(),
  });
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
  context.subscriptions.push(vscode.window.createTreeView("xscript.devices", { treeDataProvider: tree, showCollapseAll: false }));
  registerUiDesigner(context, output);
  registerDebugger(context, output, () => config().get<string>("device", "127.0.0.1:9860"), tokenFor);
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("xscript.device")) {
        client = makeClient();
        void refreshStatus();
        tree.refresh();
      }
    }),
  );
  const watcher = vscode.workspace.createFileSystemWatcher("**/{__init__.py,build.as}");
  const ctxUpdate = () => void updateProjectContext();
  context.subscriptions.push(watcher, watcher.onDidCreate(ctxUpdate), watcher.onDidDelete(ctxUpdate), vscode.workspace.onDidChangeWorkspaceFolders(ctxUpdate));
  void updateProjectContext();

  // The app shows "AI 编程连接" for 90 s after the last request; a light status poll keeps it current
  // (and keeps the Run / Stop buttons right while a script runs: faster poll then).
  let timer: NodeJS.Timeout | undefined;
  let disposed = false;
  const loop = () => {
    timer = setTimeout(async () => {
      await refreshStatus();
      if (isRunning) tree.refresh();
      if (!disposed) loop();
    }, isRunning ? 3000 : 30000);
  };
  loop();
  context.subscriptions.push({ dispose: () => { disposed = true; if (timer) clearTimeout(timer); } });
  void loadPairing().then(() => {
    client.token = tokenFor(client.target);
    tree.refresh();
    return refreshStatus();
  });
  return { store, tree, refreshStatus, statusText: () => statusItem.text };
}

export function deactivate(): void {
  stopFollowing();
}
