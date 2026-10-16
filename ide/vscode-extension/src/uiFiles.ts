// UI designer file output (free of `vscode` so it runs under node --test).
import * as fs from "fs";
import * as path from "path";
import { findProjectRoot } from "./project";
import { FormSpec, formName, outputs, parseSpec, validateSpec } from "./uiForm";

/** Writes the generated files for a saved spec; returns the paths written (relative to the project). */
export function generateFor(specFile: string, text: string, log?: (s: string) => void): string[] {
  const name = formName(specFile);
  if (!name) return [];
  let spec: FormSpec;
  try {
    spec = parseSpec(text);
  } catch (e) {
    log?.("[xscript] UI designer: " + specFile + " is not valid JSON (" + (e as Error).message + "), nothing generated");
    return [];
  }
  const errs = validateSpec(spec);
  if (errs.length) {
    log?.("[xscript] UI designer: " + specFile + " not generated: " + errs.join("; "));
    return [];
  }
  const root = projectRootFor(specFile);
  const written: string[] = [];
  for (const [rel, content] of Object.entries(outputs(spec, name))) {
    const full = path.join(root, ...rel.split("/"));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (fs.existsSync(full) && fs.readFileSync(full, "utf-8") === content) continue;
    fs.writeFileSync(full, content, "utf-8");
    written.push(rel);
  }
  if (written.length) log?.("[xscript] UI designer wrote " + written.join(", ") + " in " + root);
  return written;
}

/** The project the spec belongs to; a spec at <root>/res/ui/x.ui.json outside any project still maps to <root>. */
export function projectRootFor(specFile: string): string {
  const dir = path.dirname(specFile);
  const byLayout = path.basename(dir) === "ui" && path.basename(path.dirname(dir)) === "res" ? path.dirname(path.dirname(dir)) : undefined;
  return findProjectRoot(specFile) ?? byLayout ?? dir;
}

