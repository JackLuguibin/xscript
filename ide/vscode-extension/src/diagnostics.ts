// Shows lint.ts's checks (the Web IDE's basic checks) in the Problems panel and as squiggles for .py files inside
// an XScript project. Re-checked 400 ms after an edit, and on open/save. Off with "xscript.lint": false.
import * as path from "path";
import * as vscode from "vscode";
import { lintFile, projectSources } from "./lint";
import { findProjectRoot } from "./project";

export function registerDiagnostics(context: vscode.ExtensionContext, output: vscode.OutputChannel): void {
  const collection = vscode.languages.createDiagnosticCollection("xscript");
  const timers = new Map<string, NodeJS.Timeout>();
  const enabled = () => vscode.workspace.getConfiguration("xscript").get<boolean>("lint", true);

  const check = (doc: vscode.TextDocument) => {
    if (doc.uri.scheme !== "file" || !doc.fileName.endsWith(".py")) return;
    if (!enabled()) return collection.delete(doc.uri);
    const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
    const root = findProjectRoot(doc.fileName, folder?.uri.fsPath);
    if (!root) return collection.delete(doc.uri);
    try {
      const open = new Map<string, string>();
      for (const d of vscode.workspace.textDocuments) if (d.uri.scheme === "file" && d.fileName.endsWith(".py")) open.set(d.fileName, d.getText());
      const rel = path.relative(root, doc.fileName).split(path.sep).join("/");
      const diags = lintFile(projectSources(root, open), rel).map((p) => {
        const start = new vscode.Position(Math.max(0, p.line - 1), p.col);
        const d = new vscode.Diagnostic(new vscode.Range(start, start.translate(0, p.length)), p.message,
          p.severity === "unused" ? vscode.DiagnosticSeverity.Hint : vscode.DiagnosticSeverity.Warning);
        d.source = "XScript";
        if (p.severity === "unused") d.tags = [vscode.DiagnosticTag.Unnecessary];
        return d;
      });
      collection.set(doc.uri, diags);
    } catch (e) {
      output.appendLine("XScript check failed for " + doc.fileName + ": " + String((e as Error)?.message || e));
    }
  };
  const later = (doc: vscode.TextDocument) => {
    const key = doc.uri.toString();
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => { timers.delete(key); check(doc); }, 400));
  };
  const all = () => vscode.workspace.textDocuments.forEach(check);

  context.subscriptions.push(
    collection,
    { dispose: () => timers.forEach((t) => clearTimeout(t)) },
    vscode.workspace.onDidOpenTextDocument(check),
    vscode.workspace.onDidSaveTextDocument(all),
    vscode.workspace.onDidChangeTextDocument((e) => later(e.document)),
    vscode.workspace.onDidCloseTextDocument((doc) => collection.delete(doc.uri)),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration("xscript.lint")) all(); }),
  );
  all();
}
