// Shows lint.ts's checks (the Web IDE's basic checks) in the Problems panel and as squiggles for .py files inside
// an XScript project. Re-checked 400 ms after an edit, and on open/save. Off with "xscript.lint": false.
import * as path from "path";
import * as vscode from "vscode";
import { Fix, lintFile, projectSources } from "./lint";
import { findProjectRoot } from "./project";

export function registerDiagnostics(context: vscode.ExtensionContext, output: vscode.OutputChannel): void {
  const collection = vscode.languages.createDiagnosticCollection("xscript");
  const timers = new Map<string, NodeJS.Timeout>();
  // uri -> the quick fixes of each XScript diagnostic, matched back by range and message in provideCodeActions
  const fixes = new Map<string, { range: vscode.Range; message: string; fixes: Fix[] }[]>();
  const enabled = () => vscode.workspace.getConfiguration("xscript").get<boolean>("lint", true);

  const check = (doc: vscode.TextDocument) => {
    if (doc.uri.scheme !== "file" || !doc.fileName.endsWith(".py")) return;
    fixes.delete(doc.uri.toString());
    if (!enabled()) return collection.delete(doc.uri);
    const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
    const root = findProjectRoot(doc.fileName, folder?.uri.fsPath);
    if (!root) return collection.delete(doc.uri);
    try {
      const open = new Map<string, string>();
      for (const d of vscode.workspace.textDocuments) if (d.uri.scheme === "file" && d.fileName.endsWith(".py")) open.set(d.fileName, d.getText());
      const rel = path.relative(root, doc.fileName).split(path.sep).join("/");
      const found: { range: vscode.Range; message: string; fixes: Fix[] }[] = [];
      const diags = lintFile(projectSources(root, open), rel).map((p) => {
        const start = new vscode.Position(Math.max(0, p.line - 1), p.col);
        const d = new vscode.Diagnostic(new vscode.Range(start, start.translate(0, p.length)), p.message,
          p.severity === "unused" ? vscode.DiagnosticSeverity.Hint : vscode.DiagnosticSeverity.Warning);
        d.source = "XScript";
        if (p.severity === "unused") d.tags = [vscode.DiagnosticTag.Unnecessary];
        if (p.fixes) found.push({ range: d.range, message: d.message, fixes: p.fixes });
        return d;
      });
      collection.set(doc.uri, diags);
      fixes.set(doc.uri.toString(), found);
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
    vscode.workspace.onDidCloseTextDocument((doc) => { collection.delete(doc.uri); fixes.delete(doc.uri.toString()); }),
    // target of the "跳到第 N 行的定义" quick fix (internal, not in the command palette)
    vscode.commands.registerCommand("xscript.revealAt", async (uri: vscode.Uri, line: number, col: number) => {
      const ed = await vscode.window.showTextDocument(uri);
      const pos = new vscode.Position(line - 1, col);
      ed.selection = new vscode.Selection(pos, pos);
      ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }),
    vscode.languages.registerCodeActionsProvider({ language: "python", scheme: "file" }, {
      provideCodeActions(doc, _range, ctx) {
        const known = fixes.get(doc.uri.toString()) || [];
        const actions: vscode.CodeAction[] = [];
        for (const d of ctx.diagnostics) {
          if (d.source !== "XScript") continue;
          const k = known.find((x) => x.range.isEqual(d.range) && x.message === d.message);
          for (const f of k?.fixes || []) {
            const a = new vscode.CodeAction(f.title, vscode.CodeActionKind.QuickFix);
            if (f.edits) {
              a.edit = new vscode.WorkspaceEdit();
              for (const e of f.edits) a.edit.replace(doc.uri, new vscode.Range(doc.positionAt(e.from), doc.positionAt(e.to)), e.text);
            }
            if (f.jump) a.command = { title: f.title, command: "xscript.revealAt", arguments: [doc.uri, f.jump.line, f.jump.col] };
            a.diagnostics = [d];
            a.isPreferred = !!f.preferred;
            actions.push(a);
          }
        }
        return actions;
      },
    }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration("xscript.lint")) all(); }),
  );
  all();
}
