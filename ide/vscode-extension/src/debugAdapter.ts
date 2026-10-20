// vscode glue for the "xscript" debug type: an inline debug adapter (no child process) that proxies DAP to the device.
import * as vscode from "vscode";
import { DeviceClient, DeviceTarget, parseTarget } from "./client";
import { XScriptDebugSession } from "./dap";
import { collectFiles, findProjectRoot, isProjectDir } from "./project";

export const DEBUG_TYPE = "xscript";

class InlineAdapter implements vscode.DebugAdapter {
  private emitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
  readonly onDidSendMessage = this.emitter.event;
  private session: XScriptDebugSession;
  private disposed = false;

  constructor(client: DeviceClient, output: vscode.OutputChannel) {
    this.session = new XScriptDebugSession(client, (m) => { if (!this.disposed) this.emitter.fire(m as vscode.DebugProtocolMessage); }, {
      prepare: async (project, root) => {
        await vscode.workspace.saveAll(false);
        const files = collectFiles(root);
        await client.uploadFiles(project, files);
        output.appendLine("[xscript] uploaded " + project + " (" + files.length + " files) for debugging");
      },
      log: (t) => output.appendLine(t),
    });
  }

  handleMessage(message: vscode.DebugProtocolMessage): void {
    void this.session.handle(message as any);
  }

  dispose(): void {
    // The editor can drop a session without a disconnect (window closed): still detach so the script is not left paused.
    if (!this.disposed && this.session.state.connected && !this.session.state.ended) {
      void this.session.handle({ seq: 0, type: "request", command: "disconnect", arguments: { terminateDebuggee: true } });
    }
    this.disposed = true;
    setTimeout(() => this.session.dispose(), 3000).unref?.();   // let the detach above finish first
    this.emitter.dispose();
  }
}

export function registerDebugger(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  deviceSetting: () => string,
  tokenFor: (target: DeviceTarget) => string = () => "",
): void {
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, {
      createDebugAdapterDescriptor(session) {
        const target = parseTarget(String(session.configuration.device || deviceSetting()));
        return new vscode.DebugAdapterInlineImplementation(new InlineAdapter(new DeviceClient(target, undefined, tokenFor(target)), output));
      },
    }),
    vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, {
      resolveDebugConfiguration(folder, config) {
        const c = { ...config } as vscode.DebugConfiguration;
        c.type = DEBUG_TYPE; c.request = c.request || "launch"; c.name = c.name || "XScript: Debug on device";
        if (!c.projectRoot) {
          const doc = vscode.window.activeTextEditor?.document;
          const start = doc?.uri.scheme === "file" ? doc.uri.fsPath : folder?.uri.fsPath;
          c.projectRoot = start ? findProjectRoot(start, folder?.uri.fsPath) ?? (folder && isProjectDir(folder.uri.fsPath) ? folder.uri.fsPath : undefined) : undefined;
        }
        if (!c.projectRoot || !isProjectDir(String(c.projectRoot))) {
          void vscode.window.showErrorMessage("XScript: no project to debug. Open a folder with __init__.py or set \"projectRoot\" in launch.json.");
          return null;   // abort the launch
        }
        return c;
      },
    }),
  );
}

/** "XScript: Debug Project": build a launch configuration for the project and start it. */
export async function startDebugging(root: string): Promise<boolean> {
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root));
  return vscode.debug.startDebugging(folder, {
    type: DEBUG_TYPE, request: "launch", name: "XScript: " + root.split(/[\\/]/).pop(), projectRoot: root,
  });
}
