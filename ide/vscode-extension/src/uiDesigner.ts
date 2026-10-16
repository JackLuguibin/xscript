// UI designer: a custom editor for res/ui/<name>.ui.json. The webview (media/uiDesigner.js) edits the form spec;
// the text document stays the source of truth (undo/redo, dirty state, save are VS Code's), and saving writes
// res/ui/<name>.html + ui_<name>.py into the project (src/uiForm.ts).
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { findProjectRoot } from "./project";
import { FIELD_KINDS, FormSpec, formName, newSpec, parseSpec, renderHtml, serializeSpec, validateSpec } from "./uiForm";
import { generateFor } from "./uiFiles";

export const VIEW_TYPE = "xscript.uiDesigner";

class Provider implements vscode.CustomTextEditorProvider {
  constructor(private readonly ctx: vscode.ExtensionContext) {}

  resolveCustomTextEditor(doc: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, "media");
    panel.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const script = panel.webview.asWebviewUri(vscode.Uri.joinPath(media, "uiDesigner.js"));
    const css = panel.webview.asWebviewUri(vscode.Uri.joinPath(media, "uiDesigner.css"));
    panel.webview.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; frame-src 'self' data:;">
<link rel="stylesheet" href="${css}"></head><body data-kinds="${FIELD_KINDS.join(",")}"><div id="app"></div>
<script nonce="${nonce}" src="${script}"></script></body></html>`;

    let lastSent = "";
    const push = () => {
      let spec: FormSpec | undefined;
      let error: string | undefined;
      const text = doc.getText();
      try {
        spec = text.trim() ? parseSpec(text) : newSpec();
      } catch (e) {
        error = "Invalid JSON: " + (e as Error).message + " (fix it in the text editor: Reopen Editor With… → Text Editor)";
      }
      const msg = spec ? { type: "spec", spec, errors: validateSpec(spec), preview: renderHtml(spec) } : { type: "error", error };
      const key = JSON.stringify(msg);
      if (key === lastSent) return;
      lastSent = key;
      void panel.webview.postMessage(msg);
    };
    const subs = [
      vscode.workspace.onDidChangeTextDocument((e) => { if (e.document.uri.toString() === doc.uri.toString()) push(); }),
      panel.webview.onDidReceiveMessage(async (m) => {
        if (m?.type === "ready") { lastSent = ""; push(); }
        if (m?.type === "edit" && m.spec) {
          const text = serializeSpec(m.spec as FormSpec);
          if (text === doc.getText()) return;
          const edit = new vscode.WorkspaceEdit();
          edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), text);
          await vscode.workspace.applyEdit(edit);
        }
      }),
    ];
    panel.onDidDispose(() => subs.forEach((s) => s.dispose()));
  }
}

export function registerUiDesigner(ctx: vscode.ExtensionContext, output: vscode.OutputChannel): void {
  ctx.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, new Provider(ctx), { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.scheme === "file" && formName(doc.uri.fsPath)) generateFor(doc.uri.fsPath, doc.getText(), (s) => output.appendLine(s));
    }),
  );
}

/** XScript: New UI Form — creates res/ui/<name>.ui.json in the current project and opens it in the designer. */
export async function newUiForm(arg?: { root?: string; name?: string }): Promise<vscode.Uri | undefined> {
  let root = arg?.root;
  if (!root) {
    const active = vscode.window.activeTextEditor?.document.uri;
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    root = (active?.scheme === "file" ? findProjectRoot(active.fsPath, folder) : undefined) ?? (folder ? findProjectRoot(folder) ?? folder : undefined);
  }
  if (!root) return void vscode.window.showErrorMessage("XScript: open a project folder first");
  const name = arg?.name ?? (await vscode.window.showInputBox({
    prompt: "Form name (res/ui/<name>.ui.json; the script imports ui_<name>)",
    value: "settings",
    validateInput: (v) => (formName(v + ".ui.json") ? undefined : "Use letters, digits and underscores, starting with a letter or underscore"),
  }));
  if (!name) return undefined;
  const file = path.join(root, "res", "ui", name + ".ui.json");
  if (!fs.existsSync(file)) {
    const spec = newSpec("设置");
    spec.fields = [
      { kind: "text", id: "name", label: "名称", default: "" },
      { kind: "number", id: "rounds", label: "次数", default: 3, min: 1 },
      { kind: "checkbox", id: "loop", label: "循环执行", default: false },
    ];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, serializeSpec(spec), "utf-8");
    generateFor(file, serializeSpec(spec));
  }
  const uri = vscode.Uri.file(file);
  await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);
  return uri;
}
