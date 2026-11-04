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
  { id: "newProject", label: "新建工程", icon: "new-folder", command: "xscript.newProject", tip: "从模板创建工程" },
  { id: "scan", label: "扫描设备", icon: "search", command: "xscript.scanDevices", tip: "通过 ADB（USB / 模拟器）和局域网查找设备" },
  { id: "add", label: "添加设备", icon: "add", command: "xscript.addDevice", tip: "按手机显示的开发者地址添加设备" },
  { id: "tools", label: "开发工具（图色 / 节点 / 标注）", icon: "tools", command: "xscript.openTools", tip: "在浏览器中打开设备开发工具" },
  { id: "nodes", label: "节点工具", icon: "list-tree", command: "xscript.openNodes", tip: "读取完整节点树，查看属性并生成选择器" },
  { id: "screen", label: "投屏", icon: "device-camera-video", command: "xscript.openScreen", tip: "打开设备的投屏页面" },
  { id: "shot", label: "截图", icon: "device-camera", command: "xscript.screenshot", tip: "打开当前设备的截图" },
  { id: "adb", label: "ADB 终端", icon: "terminal", command: "xscript.adbTerminal", tip: "打开当前 USB 设备或模拟器的 adb shell" },
  { id: "sync", label: "同步工程…", icon: "sync", command: "xscript.syncManage", tip: "将当前工程推送到设备，或从设备拉取工程" },
  { id: "ignore", label: "编辑同步忽略规则", icon: "exclude", command: "xscript.editSyncIgnore", tip: ".vscode/.syncignore" },
  { id: "stubs", label: "启用 API 自动补全", icon: "symbol-method", command: "xscript.configureStubs", tip: "将内置 xscript / ascript 类型文件加入 python.analysis.extraPaths" },
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
        ["devices", "设备", "device-mobile"],
        ["projects", "设备上的工程", "folder-library"],
        ["tools", "工具", "tools"],
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
      n.description = d.address + (st.online ? (st.running ? "  ▶ " + (st.project ?? "运行中") : "") : "  （离线）") + (isCur ? "  ✓ 当前使用" : "");
      n.tooltip = d.name + " — " + d.address + (st.model ? "\n" + st.model : "") + (isCur ? "\n当前命令操作此设备" : "\n点击使用此设备");
      n.contextValue = !st.online ? "xscript.device.offline" : st.running ? "xscript.device.running" : "xscript.device.idle";
      n.iconPath = new vscode.ThemeIcon(st.online ? (isCur ? "device-mobile" : "circle-large-outline") : "debug-disconnect",
        st.online && st.running ? new vscode.ThemeColor("charts.green") : undefined);
      n.command = { command: "xscript.useDevice", title: "使用此设备", arguments: [n] };
      return n;
    });
  }

  private async projects(): Promise<Node[]> {
    const cur = normalizeAddress(this.host.currentAddress());
    try {
      const names = await this.host.listProjects(cur);
      if (!names.length) return [info("设备上还没有工程")];
      return names.map((name) => {
        const n = new Node("project", name, vscode.TreeItemCollapsibleState.None, undefined, name);
        n.id = "project:" + name;
        n.contextValue = "xscript.project";
        n.iconPath = new vscode.ThemeIcon("symbol-folder");
        n.tooltip = name + " on " + cur;
        return n;
      });
    } catch {
      return [info("设备 " + cur + " 无法连接")];
    }
  }
}

function info(text: string): Node {
  const n = new Node("info", text);
  n.iconPath = new vscode.ThemeIcon("info");
  return n;
}

