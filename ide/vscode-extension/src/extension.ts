import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { DeviceClient, DeviceTarget, currentSeq as latestSeq, describeError, followTick, isPairingError, normalizeCode, parseTarget, validateCode } from "./client";
import type { RemoteFile } from "./client";
import { collectFiles, findProjectRoot, isProjectDir, isSyncedPath } from "./project";
import { registerDebugger, startDebugging } from "./debugAdapter";
import { execFile } from "child_process";
import { DeviceStore, FoundDevice, SavedDevice, httpProbe, lanCandidates, normalizeAddress, scanAdb, scanLan } from "./devices";
import { DEFAULT_SYNCIGNORE, IgnoreRules, SYNCIGNORE_PATH, SyncCache, describeDeletes, describePreview, planEmptiedFolders, previewHasWork, previewSync, diffAgainstLocal, fetchProject, loadIgnoreRules, planDeletes, planUpload, writePulled } from "./sync";
import { TEMPLATES, createProject, validateProjectName } from "./newProject";
import { Node, XScriptTree } from "./tree";
import { captureBadge, captureProblem, captureText } from "./captureStatus";
import { fixDone, missingPerms, missingText, missingWarning, type PermFix } from "./missingPerms";
import { TROUBLESHOOTING_URL, canConnect, failureSummary, formatCheck, langOf, runConnectCheck, tcpConnect, type CheckStep } from "./connectCheck";
import { newUiForm, registerUiDesigner } from "./uiDesigner";
import { registerDiagnostics } from "./diagnostics";

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
    title: "XScript：配对设备 " + addressOf(t),
    prompt: "输入手机 XScript 首页「开发与连接 → 配对码」中显示的配对码",
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
      isPairingError(err) ? "XScript：配对码错误，设备 " + addressOf(t) : "XScript：配对失败（" + describe(err) + "）",
    );
    return false;
  }
  await savePairing(t, normalizeCode(code));
  client.token = normalizeCode(code);
  tree?.refresh();
  void refreshStatus();
  vscode.window.showInformationMessage("XScript：已配对 " + addressOf(t));
  return true;
}

const describe = describeError;

async function guard<T>(what: string, fn: () => PromiseLike<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    if (isPairingError(err)) {
      output.appendLine("XScript: " + what + " 需要配对：" + client.baseUrl);
      const pick = await vscode.window.showWarningMessage(
        "XScript: " + addressOf(client.target) + " 需要输入手机首页「开发与连接 → 配对码」中的配对码。",
        "输入配对码",
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
    const msg = "XScript：" + what + "失败（" + describe(err) + "），设备：" + client.baseUrl;
    output.appendLine(msg);
    const pick = await vscode.window.showErrorMessage(msg, "检查连接", "切换设备");
    if (pick === "检查连接") await vscode.commands.executeCommand("xscript.checkConnection");
    else if (pick) await vscode.commands.executeCommand("xscript.connect");
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
      statusItem.text = "$(lock) XScript：配对 " + String(s.model || s.name || "设备");
      statusItem.tooltip = "XScript 设备 " + addr + " 需要配对码（点击配对）";
      statusItem.command = "xscript.pair";
      return;
    }
    statusItem.command = "xscript.connect";
    const running = s.running ? " $(play) " + String(s.project ?? "") : "";
    const capture = captureBadge(captureProblem(s), langOf("zh-CN"));
    statusItem.text = "$(device-mobile) " + String(s.model || s.name || "XScript") + running + capture.suffix;
    statusItem.tooltip = capture.tooltip ? "XScript " + addr + ": " + capture.tooltip : "XScript 设备 " + addr + "（点击切换）";
    if (capture.tooltip) statusItem.command = "xscript.grantCapture";
  } catch {
    isRunning = false;
    void vscode.commands.executeCommand("setContext", "xscript.running", false);
    statusItem.text = "$(debug-disconnect) XScript";
    statusItem.tooltip = "XScript 设备 " + addr + " 无法连接（点击切换）";
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
    openLabel: "作为 XScript 工程",
  });
  const dir = picked?.[0]?.fsPath;
  if (dir && !isProjectDir(dir)) {
    vscode.window.showErrorMessage("XScript: " + dir + " 中没有 __init__.py");
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
  const plan = await guard("上传", () =>
    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "XScript：正在上传 " + name },
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
    "已上传 " + name + " to " + client.baseUrl + ": " + plan.upload.length + " 个文件已发送" + (plan.skipped ? ", " + plan.skipped + " 个未修改" : ""),
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
  const ok = "删除 " + gone.length + " 个设备文件";
  const detail = describeDeletes(gone) + (folders.length ? "\n\n以下文件夹将变空，并连同其中的缓存（如 __pycache__）一起删除：\n" + describeDeletes(folders.map((d) => d + "/")) : "");
  const pick = await vscode.window.showWarningMessage(
    "XScript：工程「" + name + "」在设备上有 " + gone.length + " 个本地已删除的文件。是否删除这些设备文件" +
      (folders.length ? "，以及 " + folders.length + " 个将变空的文件夹" : "") + "？此操作无法撤销。",
    { modal: true, detail },
    ok,
  );
  if (pick !== ok) {
    output.appendLine("已保留 " + gone.length + " 个本地已删除的设备文件");
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
    "已删除 " + (gone.length - failed.filter((f) => !f.endsWith("/")).length) + " 个本地已删除的设备文件" +
      (removed ? " 以及 " + removed + " 个空文件夹" : "") + (failed.length ? "；未能删除：" + failed.join(", ") : ""),
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
        output.appendLine("[xscript] 脚本运行结束");
        stopFollowing();
        void refreshStatus();
      }
    } catch (err) {
      output.appendLine("[xscript] 日志轮询已停止：" + describe(err));
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
  if (!items.some((i) => i.dev?.address === cur)) items.unshift({ label: "$(check) " + cur, description: "当前设置", dev: { name: cur, address: cur } });
  if (withActions) {
    items.push({ label: "$(search) 扫描设备…", action: "scan" }, { label: "$(add) 添加设备…", action: "add" });
  }
  const pick = await vscode.window.showQuickPick(items, { placeHolder: placeholder, matchOnDescription: true });
  return pick ? pick.dev ?? pick.action : undefined;
}

async function addDevice(arg?: { name?: string; address?: string; quiet?: boolean }): Promise<SavedDevice | undefined> {
  let address = arg?.address;
  if (address === undefined) {
    address = await vscode.window.showInputBox({
      prompt: "手机显示的开发者地址，例如 192.168.1.20 或 192.168.1.20:9860",
      validateInput: (v) => {
        try { parseTarget(v); return v.trim() ? undefined : "请输入设备地址"; } catch (e) { return (e as Error).message; }
      },
    });
    if (address === undefined) return undefined;
  }
  const addr = normalizeAddress(address);
  const t = parseTarget(addr);
  const found = await httpProbe(2500)(t.host, t.port);
  if (!found && !arg?.quiet) {
    const pick = await vscode.window.showWarningMessage("XScript: " + addr + " 未响应，仍然保存吗？", "保存", "取消");
    if (pick !== "保存") return undefined;
  }
  let name = arg?.name;
  if (name === undefined) {
    name = await vscode.window.showInputBox({ prompt: "设备名称", value: found?.model || found?.name || addr });
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
    { location: vscode.ProgressLocation.Notification, title: "XScript：正在扫描设备" },
    async (progress) => {
      const all: FoundDevice[] = [];
      if (useAdb) {
        progress.report({ message: "ADB（USB / 模拟器）" });
        all.push(...(await scanAdb(adbPath(), runCmd, httpProbe(1500))));
      }
      if (useLan) {
        const hosts = arg?.hosts ?? lanCandidates();
        let last = 0;
        const lan = await scanLan(hosts, httpProbe(600), {
          onProgress: (done, total) => {
            const pct = Math.floor((done / total) * 100);
            if (pct > last) { progress.report({ message: "局域网 " + pct + "%", increment: pct - last }); last = pct; }
          },
        });
        for (const d of lan) if (!all.some((a) => a.model && a.model === d.model && d.address.startsWith("127."))) all.push(d);
      }
      return all;
    },
  );
  const added = await store.merge(found);
  tree?.refresh();
  output.appendLine("[xscript] 扫描发现 " + found.length + " 台设备：" + (found.map((d) => d.name + " " + d.address).join(", ") || "无"));
  if (!arg) {
    vscode.window.showInformationMessage(
      found.length ? "XScript：找到 " + found.length + " 台设备，其中 " + added + " 台为新设备。请在 XScript 侧栏选择。" : "XScript：未找到设备。请打开手机上的 XScript 并检查开发者地址；USB 连接需开启 USB 调试。",
    );
  }
  return found;
}

async function manageDevices(): Promise<void> {
  const pick = await pickDevice("管理设备", true);
  if (pick === "scan") return void (await scanDevices());
  if (pick === "add") return void (await addDevice());
  if (!pick) return;
  const act = await vscode.window.showQuickPick(["使用此设备", "重命名 / 修改地址", "从列表删除"], { placeHolder: pick.name + " — " + pick.address });
  if (act === "使用此设备") await useDevice(pick);
  else if (act === "重命名 / 修改地址") await commands["xscript.editDevice"](pick);
  else if (act === "从列表删除") await commands["xscript.removeDevice"](pick);
}

// ---------------------------------------------------------------- projects: new, pull, sync

const TEMPLATE_ZH: Record<string, { label: string; detail: string }> = {
  "empty": {
    "label": "空白工程",
    "detail": "只有 __init__.py、build.as 和 res/"
  },
  "hello": {
    "label": "Hello（屏幕 + 点击）",
    "detail": "打印屏幕尺寸并点击屏幕中间"
  },
  "ascript": {
    "label": "AScript 风格",
    "detail": "from ascript.android import ...（兼容层）"
  },
  "checkin": {
    "label": "每日签到",
    "detail": "打开 App，用 OCR 找到按钮并点击，回到桌面"
  },
  "findImage": {
    "label": "找图并点击",
    "detail": "在屏幕上匹配 res/img/target.png 并点击"
  },
  "ocr": {
    "label": "OCR 读文字",
    "detail": "读取屏幕上所有文字行并提取数字"
  },
  "floatUi": {
    "label": "悬浮窗界面",
    "detail": "HTML 设置窗口（res/ui/main.html）+ 悬浮窗菜单"
  }
};

async function newProject(arg?: { parent?: string; name?: string; template?: string; open?: boolean }): Promise<string | undefined> {
  const tpl = arg?.template
    ? TEMPLATES.find((t) => t.id === arg.template)
    : (await vscode.window.showQuickPick(TEMPLATES.map((t) => ({ label: TEMPLATE_ZH[t.id]?.label ?? t.label, description: TEMPLATE_ZH[t.id]?.detail ?? t.detail, t })), { placeHolder: "工程模板" }))?.t;
  if (!tpl) return undefined;
  const name =
    arg?.name ?? (await vscode.window.showInputBox({ prompt: "工程名称（同时用作设备上的工程名）", validateInput: validateProjectName }));
  if (!name) return undefined;
  let parent = arg?.parent;
  if (!parent) {
    const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: "在此处创建工程" });
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
  output.appendLine("[xscript] 已创建工程 " + dir + " (" + tpl.id + ")");
  if (arg?.open === false) return dir;
  const pick = await vscode.window.showInformationMessage("XScript：已创建 " + name, "在新窗口打开", "在当前窗口打开");
  if (pick) await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(dir), { forceNewWindow: pick === "在新窗口打开" });
  return dir;
}

async function pullProject(arg?: unknown): Promise<{ written: number; added: string[]; changed: string[]; dest: string } | undefined> {
  const a = (arg && !(arg instanceof Node) ? arg : {}) as { project?: string; dest?: string; overwrite?: boolean };
  let project = arg instanceof Node ? arg.project : a.project;
  if (!project) {
    const names = await guard("列出工程", () => client.listProjects());
    if (!names) return undefined;
    if (!names.length) return void vscode.window.showInformationMessage("XScript：设备上还没有工程");
    project = await vscode.window.showQuickPick(names, { placeHolder: "选择要拉取的工程：" + client.baseUrl });
    if (!project) return undefined;
  }
  let dest = a.dest;
  if (!dest) {
    const open = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath).find((p) => path.basename(p) === project && isProjectDir(p));
    if (open) dest = open;
    else {
      const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: "在此处新建文件夹并拉取" });
      if (!picked?.[0]) return undefined;
      dest = path.join(picked[0].fsPath, project);
    }
  }
  const name = project;
  const pulled = await guard("拉取", () =>
    vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "XScript：正在拉取 " + name }, () => fetchProject(client, name)),
  );
  if (!pulled) return undefined;
  const diff = diffAgainstLocal(dest, pulled);
  if (diff.changed.length && !a.overwrite) {
    const pick = await vscode.window.showWarningMessage(
      "XScript: " + diff.changed.length + " 个本地文件与设备不同，将被覆盖（" + diff.changed.slice(0, 3).join(", ") + (diff.changed.length > 3 ? ", …" : "") + ").",
      { modal: true },
      "覆盖",
    );
    if (pick !== "覆盖") return undefined;
  }
  const written = writePulled(dest, pulled, diff);
  output.appendLine("[xscript] 已拉取 " + name + " 到 " + dest + ": " + diff.added.length + " 个新文件，" + diff.changed.length + " 个已更新，" + diff.unchanged.length + " 个未修改");
  if (a.dest === undefined) {
    const pick = await vscode.window.showInformationMessage("XScript：已拉取 " + name + " (" + written + " 个文件已写入）", "打开文件夹");
    if (pick) await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(dest), { forceNewWindow: false });
  }
  return { written, added: diff.added, changed: diff.changed, dest };
}

async function adbTerminal(): Promise<void> {
  const adb = adbPath();
  const list = (await runCmd(adb, ["devices"])).stdout;
  const serials = list.split(/\r?\n/).slice(1).map((l) => l.trim().split(/\s+/)).filter((p) => p[1] === "device").map((p) => p[0]);
  if (!serials.length) return void vscode.window.showWarningMessage("XScript：ADB 未发现 USB 设备或模拟器（" + adb + ")");
  const port = String(parseTarget(currentAddress()).port);
  const fwd = (await runCmd(adb, ["forward", "--list"])).stdout.split(/\r?\n/).map((l) => l.trim().split(/\s+/)).find((p) => p[1] === "tcp:" + port && serials.includes(p[0]));
  let serial = fwd?.[0] ?? (serials.length === 1 ? serials[0] : undefined);
  if (!serial) serial = await vscode.window.showQuickPick(serials, { placeHolder: "选择 ADB 设备" });
  if (!serial) return;
  vscode.window.createTerminal({ name: "adb shell " + serial, shellPath: adb, shellArgs: ["-s", serial, "shell"] }).show();
}

/** Starts an uploaded project and follows its logs. */
async function startRun(name: string): Promise<void> {
  const since = (await guard("读取日志", currentSeq)) ?? 0;
  const r = await guard("运行", () => client.run(name));
  if (!r) return;
  if (r.error) {
    vscode.window.showWarningMessage("XScript: " + String(r.error) + (r.project ? " (" + String(r.project) + ")" : ""));
    return;
  }
  output.show(true);
  output.appendLine("[xscript] 正在运行 " + name);
  void warnMissing(r, name);
  await startFollowing(since);
}

/** Stops whatever runs on the device before a re-run (waits up to 5 s for it to end); false when that failed. */
async function stopForRerun(name: string): Promise<boolean> {
  const st = await guard("读取状态", () => client.status());
  if (!st) return false;
  if (st.running) {
    const busy = String(st.project || name);
    output.appendLine("[xscript] 正在停止 " + busy + "，准备重新运行");
    if (!(await guard("停止", () => client.stop(busy)))) return false;
    for (let i = 0; i < 20; i++) {
      const now = await client.status(3000).catch(() => st);
      if (!now.running) break;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  return true;
}

/** The run reply lists permissions the code uses but the phone lacks: warn, offer the one-tap fixes one after another (Next),
 * and after the last one offer to run `name` again. */
async function warnMissing(reply: Record<string, unknown>, name: string): Promise<void> {
  const lang = langOf("zh-CN");
  const warning = missingWarning(missingPerms(reply), lang);
  if (!warning) return;
  output.appendLine("[xscript] " + warning.text);
  let fixes = warning.fixes;
  let button: string | undefined = fixes[0]?.button;
  let pick = await vscode.window.showWarningMessage(warning.text, ...(button ? [button] : []));
  while (fixes.length && pick === button) {
    const text = await applyFix(fixes[0], lang);
    if (text === undefined) return;
    fixes = fixes.slice(1);
    const done = fixDone(text, fixes, lang);
    button = done.next;
    pick = await vscode.window.showInformationMessage(done.text, button);
    if (done.again) {
      if (pick === button && (await stopForRerun(name))) await startRun(name);
      return;
    }
  }
}

/** Runs one fix on the phone: the message to show, or undefined after a failure (already reported). */
async function applyFix(fix: PermFix, lang: "zh" | "en"): Promise<string | undefined> {
  const t = missingText(lang);
  if (fix.capture) {
    const ok = await guard("授权截图", () => client.requestCapture());
    if (ok === undefined) return undefined;
    if (ok) return fix.opened;
    vscode.window.showWarningMessage(t.failed(lang === "zh" ? "手机上的 XScript 版本过旧" : "the phone app is too old", fix.where));
    return undefined;
  }
  const r = await guard("打开 " + fix.label + " 设置", () => client.eval(fix.code ?? "", 5000));
  if (!r) return undefined;
  if (!r.ok) {
    vscode.window.showWarningMessage(t.failed(String(r.error ?? "?"), fix.where));
    return undefined;
  }
  return String(r.result) === "1" && fix.on ? fix.on : fix.opened;
}

/** Runs the step-by-step check with a progress notification and writes every step to the output channel. */
async function checkConnection(address: string): Promise<CheckStep[]> {
  const lang = langOf("zh-CN");
  const steps = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: (lang === "zh" ? "XScript：正在检查 " : "XScript: checking ") + address },
    () => runConnectCheck(address, { connect: (t) => tcpConnect(t), status: (t) => deviceClient(t, 5000).status(5000) }),
  );
  for (const line of formatCheck(address, steps, lang)) output.appendLine(line);
  return steps;
}

/** After a failed check: say where it stopped and offer the fixes. "retry" re-asks for the address, "save" keeps it anyway. */
async function reportFailedCheck(steps: CheckStep[]): Promise<"retry" | "save" | undefined> {
  const lang = langOf("zh-CN");
  output.show(true);
  const [edit, save, help] = lang === "zh" ? ["修改地址", "仍然保存", "排查文档"] : ["Edit Address", "Save Anyway", "Troubleshooting"];
  const pick = await vscode.window.showErrorMessage("XScript: " + failureSummary(steps, lang), edit, save, help);
  if (pick === help) await vscode.env.openExternal(vscode.Uri.parse(TROUBLESHOOTING_URL));
  return pick === edit ? "retry" : pick === save ? "save" : undefined;
}

const commands: Record<string, (...args: any[]) => unknown> = {
  "xscript.connect": async (prefill?: unknown) => {
    const value = await vscode.window.showInputBox({
      prompt: "手机显示的开发者地址；保存前会逐项检查连接",
      value: typeof prefill === "string" ? prefill : config().get<string>("device", "127.0.0.1:9860"),
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
    const steps = await checkConnection(value.trim());
    if (!canConnect(steps)) {
      const next = await reportFailedCheck(steps);
      if (next === "retry") return vscode.commands.executeCommand("xscript.connect", value.trim());
      if (next !== "save") return;
    }
    const target = vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
    await config().update("device", value.trim(), target);
    client = makeClient();
    const s = await guard("连接", () => client.status(5000));
    if (s) {
      await store.merge([{ name: String(s.model || s.name || value.trim()), address: normalizeAddress(value) }]);
      tree?.refresh();
      vscode.window.showInformationMessage("XScript：已连接 " + String(s.model || s.name) + " at " + client.baseUrl);
    }
  },

  "xscript.pair": () => pairDevice(),

  "xscript.checkConnection": async () => {
    const address = config().get<string>("device", "127.0.0.1:9860");
    const steps = await checkConnection(address);
    if (steps.every((s) => s.ok === true)) {
      vscode.window.showInformationMessage(langOf("zh-CN") === "zh" ? "XScript：每一步都通了，" + address + " 可以连接。" : "XScript：连接检查全部通过 " + address + ".");
      return;
    }
    const next = await reportFailedCheck(steps);
    if (next === "retry") await vscode.commands.executeCommand("xscript.connect", address);
  },

  "xscript.grantCapture": async () => {
    const t = captureText(langOf("zh-CN"));
    const pick = await vscode.window.showWarningMessage(t.ask, t.grant, t.help);
    if (pick === t.help) {
      await vscode.env.openExternal(vscode.Uri.parse(TROUBLESHOOTING_URL));
      return;
    }
    if (pick !== t.grant) return;
    const ok = await guard("授权截图", () => client.requestCapture());
    if (ok === undefined) return;
    if (ok) vscode.window.showInformationMessage(t.requested);
    else vscode.window.showWarningMessage(t.old);
    void refreshStatus();
  },

  "xscript.newUiForm": (arg?: { root?: string; name?: string }) => newUiForm(arg),

  "xscript.status": async () => {
    const s = await guard("读取状态", () => client.status());
    if (!s) return;
    output.appendLine(JSON.stringify(s, null, 2));
    output.show(true);
  },

  "xscript.previewUpload": async (uri?: vscode.Uri) => {
    const root = await resolveProject(uri);
    if (!root) return;
    const name = path.basename(root);
    const ignore = loadIgnoreRules(root);
    const files = collectFiles(root, ignore);
    const key = "sync:" + client.target.host + ":" + client.target.port + ":" + name;
    // a project the device does not have yet: every file is new
    const got = await guard("预览", async () => ({ files: await client.projectFiles(name) }));
    if (!got) return;
    const p = previewSync(files, got.files ?? [], extCtx.workspaceState.get<SyncCache>(key, {}), (rel) => isSyncedPath(rel, ignore),
      config().get<boolean>("syncDeletes", false));
    output.appendLine(describePreview(name, p));
    output.show(true);
    if (!previewHasWork(p)) return;
    const go = "上传更改";
    const summary = p.added.length + " 个新文件，" + p.changed.length + " 个更改" + (p.deletes.length ? ", " + p.deletes.length + " 个待删除（先确认）" : "");
    if ((await vscode.window.showInformationMessage("XScript：上传预览 " + name + ": " + summary + ".", go)) !== go) return;
    // the same incremental upload Run does; deletes still go through their own confirmation
    if (await upload(root, false)) vscode.window.showInformationMessage("XScript：已上传 " + name);
  },

  "xscript.upload": async (uri?: vscode.Uri) => {
    const root = await resolveProject(uri);
    if (root && (await upload(root))) vscode.window.showInformationMessage("XScript：已上传 " + path.basename(root));
  },

  "xscript.run": async (uri?: vscode.Uri) => {
    const root = await resolveProject(uri);
    if (!root) return;
    const name = path.basename(root);
    // Like AScript: running again stops the current run first, then syncs and starts.
    if (!(await stopForRerun(name))) return;
    if (!(await upload(root, false))) return;
    await startRun(name);
  },

  "xscript.debug": async (uri?: vscode.Uri) => {
    const root = await resolveProject(uri);
    if (!root) return;
    output.show(true);
    if (!(await startDebugging(root))) vscode.window.showWarningMessage("XScript：调试未能启动，请查看 XScript 输出");
  },

  "xscript.stop": async (uri?: vscode.Uri | Node) => {
    if (uri instanceof Node && uri.device) await useDevice(uri.device);
    const s = await guard("读取状态", () => client.status());
    if (!s) return;
    let name = s.project ? String(s.project) : "";
    if (!name) {
      const root = await resolveProject(uri instanceof Node ? undefined : uri);
      if (!root) return;
      name = path.basename(root);
    }
    if (await guard("停止", () => client.stop(name))) output.appendLine("[xscript] 已停止 " + name);
  },

  "xscript.logs": async () => {
    if (follow) {
      stopFollowing();
      output.appendLine("[xscript] 已停止跟踪日志");
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
    const r = await guard("执行选中代码", () => client.eval(code, timeout));
    if (!r) return;
    output.show(true);
    output.appendLine(">>> " + code.split("\n").join("\n... "));
    output.appendLine(r.ok ? String(r.result ?? "") : "错误：" + String(r.error ?? ""));
  },

  "xscript.selectDevice": async () => {
    const pick = await pickDevice("选择运行设备", true);
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
    const d = (await deviceFromArg(arg)) ?? ((await pickDevice("选择要编辑的设备", false)) as SavedDevice | undefined);
    if (!d || typeof d === "string") return;
    const a = arg as { newName?: string; newAddress?: string } | undefined;
    const name = a?.newName ?? (await vscode.window.showInputBox({ prompt: "名称", value: d.name }));
    if (name === undefined) return;
    const address = a?.newAddress ?? (await vscode.window.showInputBox({ prompt: "地址（开发者地址）", value: d.address, validateInput: (v) => { try { parseTarget(v); return undefined; } catch (e) { return (e as Error).message; } } }));
    if (address === undefined) return;
    await store.edit(d.address, { name, address });
    tree.refresh();
  },
  "xscript.removeDevice": async (arg?: unknown) => {
    const d = (await deviceFromArg(arg)) ?? ((await pickDevice("选择要删除的设备", false)) as SavedDevice | undefined);
    if (!d || typeof d === "string") return;
    const quiet = !!(arg && typeof arg === "object" && (arg as { quiet?: boolean }).quiet);
    if (!quiet && (await vscode.window.showWarningMessage("XScript：将 " + d.name + " (" + d.address + "）从列表中删除吗？", { modal: true }, "删除")) !== "删除") return;
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
      [{ label: "$(cloud-upload) 将当前工程推送到设备", id: "push" }, { label: "$(cloud-download) 从设备拉取工程", id: "pull" }],
      { placeHolder: "同步设备：" + client.baseUrl },
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
    const png = await guard("截图", () => client.screenPng());
    if (!png) return;
    const dir = ctx.globalStorageUri.fsPath;
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "screen-" + Date.now() + ".png");
    fs.writeFileSync(file, png);
    await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(file), { preview: true });
  },

  "xscript.openNodes": async () => {
    await vscode.env.openExternal(vscode.Uri.parse(client.baseUrl + "/tools/ui/editor.html#nodes"));
  },

  "xscript.openTools": async () => {
    await vscode.env.openExternal(vscode.Uri.parse(client.baseUrl + "/tools/"));
  },

  "xscript.configureStubs": async (ctx: vscode.ExtensionContext) => {
    const stubs = path.join(ctx.extensionPath, "stubs");
    if (!fs.existsSync(stubs)) {
      vscode.window.showErrorMessage("XScript：缺少内置 API 类型文件，请重新编译插件（npm run compile）");
      return;
    }
    // Pylance / Pyright and Cursor's Python extension both read python.analysis.extraPaths.
    const py = vscode.workspace.getConfiguration("python.analysis");
    const paths = (py.get<string[]>("extraPaths") ?? []).filter((p) => !p.includes("xscript") || p === stubs);
    if (!paths.includes(stubs)) paths.push(stubs);
    await py.update("extraPaths", paths, vscode.ConfigurationTarget.Workspace);
    vscode.window.showInformationMessage("XScript：已启用 xscript.* 和 ascript.* API 自动补全");
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
  registerDiagnostics(context, output);
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
