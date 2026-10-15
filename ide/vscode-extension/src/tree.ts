// The XScript side-bar: saved devices (with live state), the projects on the current device, and tools.
import * as vscode from "vscode";
import { DeviceClient } from "./client";
import { DeviceStore, SavedDevice, normalizeAddress } from "./devices";

export type NodeKind = "group" | "device" | "project" | "tool" | "info";

export interface DeviceState {
  online: boolean;
  running: boolean;
  project?: string;
  model?: string;
}

export interface TreeHost {
  store: DeviceStore;
  currentAddress(): string;
  /** GET /status of any address; undefined when unreachable */
  probe(address: string): Promise<DeviceState>;
  listProjects(address: string): Promise<string[]>;
}

export class Node extends vscode.TreeItem {
  constructor(
    public readonly kind: NodeKind,
    label: string,
    collapsible = vscode.TreeItemCollapsibleState.None,
    public readonly device?: SavedDevice,
    public readonly project?: string,
  ) {
    super(label, collapsible);
  }
}

const TOOLS: { id: string; label: string; icon: string; command: string; tip: string }[] = [
  { id: "newProject", label: "New Project", icon: "new-folder", command: "xscript.newProject", tip: "Create a project from a template" },
  { id: "scan", label: "Scan Devices", icon: "search", command: "xscript.scanDevices", tip: "Find devices over ADB (USB / emulator) and the local network" },
  { id: "add", label: "Add Device", icon: "add", command: "xscript.addDevice", tip: "Add a device by its 开发者地址" },
  { id: "tools", label: "Developer Tools (图色 / 标注)", icon: "tools", command: "xscript.openTools", tip: "Open the device's web tools in the browser" },
  { id: "screen", label: "Screen Mirror (投屏)", icon: "device-camera-video", command: "xscript.openScreen", tip: "Open the device's screen mirror page" },
  { id: "shot", label: "Screenshot", icon: "device-camera", command: "xscript.screenshot", tip: "Open a screenshot of the current device" },
  { id: "adb", label: "ADB Terminal", icon: "terminal", command: "xscript.adbTerminal", tip: "adb shell on the current USB / emulator device" },
  { id: "sync", label: "Sync Project…", icon: "sync", command: "xscript.syncManage", tip: "Push the current project to, or pull one from, the device" },
  { id: "ignore", label: "Edit Sync Ignore Rules", icon: "exclude", command: "xscript.editSyncIgnore", tip: ".vscode/.syncignore" },
  { id: "stubs", label: "Enable API Autocomplete", icon: "symbol-method", command: "xscript.configureStubs", tip: "Add the bundled xscript / ascript stubs to python.analysis.extraPaths" },
];

export class XScriptTree implements vscode.TreeDataProvider<Node> {
  private emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private host: TreeHost) {}

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(n: Node): vscode.TreeItem {
    return n;
  }

  async getChildren(parent?: Node): Promise<Node[]> {
    const E = vscode.TreeItemCollapsibleState;
    if (!parent) {
      const groups = [
        ["devices", "Devices", "device-mobile"],
        ["projects", "Projects on device", "folder-library"],
        ["tools", "Tools", "tools"],
      ] as const;
      return groups.map(([id, label, icon]) => {
        const n = new Node("group", label, E.Expanded);
        n.id = "group:" + id;
        n.iconPath = new vscode.ThemeIcon(icon);
        return n;
      });
    }
    if (parent.kind !== "group") return [];
    switch (parent.id) {
      case "group:devices":
        return this.devices();
      case "group:projects":
        return this.projects();
      default:
        return TOOLS.map((t) => {
          const n = new Node("tool", t.label);
          n.id = "tool:" + t.id;
          n.iconPath = new vscode.ThemeIcon(t.icon);
          n.tooltip = t.tip;
          n.command = { command: t.command, title: t.label };
          return n;
        });
    }
  }

  private async devices(): Promise<Node[]> {
    const saved = this.host.store.list();
    const cur = normalizeAddress(this.host.currentAddress());
    // the device in use is always listed, even when it was never saved
    if (!saved.some((d) => d.address === cur)) saved.unshift({ name: cur, address: cur });
    const states = await Promise.all(saved.map((d) => this.host.probe(d.address)));
    return saved.map((d, i) => {
      const st = states[i];
      const n = new Node("device", d.name, vscode.TreeItemCollapsibleState.None, d);
      n.id = "device:" + d.address;
      const isCur = d.address === cur;
      n.description = d.address + (st.online ? (st.running ? "  ▶ " + (st.project ?? "running") : "") : "  (offline)") + (isCur ? "  ✓ in use" : "");
      n.tooltip = d.name + " — " + d.address + (st.model ? "\n" + st.model : "") + (isCur ? "\nThe device commands run against" : "\nClick to use this device");
      n.contextValue = !st.online ? "xscript.device.offline" : st.running ? "xscript.device.running" : "xscript.device.idle";
      n.iconPath = new vscode.ThemeIcon(st.online ? (isCur ? "device-mobile" : "circle-large-outline") : "debug-disconnect",
        st.online && st.running ? new vscode.ThemeColor("charts.green") : undefined);
      n.command = { command: "xscript.useDevice", title: "Use this device", arguments: [n] };
      return n;
    });
  }

  private async projects(): Promise<Node[]> {
    const cur = normalizeAddress(this.host.currentAddress());
    try {
      const names = await this.host.listProjects(cur);
      if (!names.length) return [info("No projects on this device yet")];
      return names.map((name) => {
        const n = new Node("project", name, vscode.TreeItemCollapsibleState.None, undefined, name);
        n.id = "project:" + name;
        n.contextValue = "xscript.project";
        n.iconPath = new vscode.ThemeIcon("symbol-folder");
        n.tooltip = name + " on " + cur;
        return n;
      });
    } catch {
      return [info("Device " + cur + " is not reachable")];
    }
  }
}

function info(text: string): Node {
  const n = new Node("info", text);
  n.iconPath = new vscode.ThemeIcon("info");
  return n;
}

