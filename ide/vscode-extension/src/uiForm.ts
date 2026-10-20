// UI designer core: a form spec (res/ui/<name>.ui.json) -> the HTML page ui.Window shows and the Python that
// shows it and returns the filled values. The implementation is shared with the Web IDE and lives in
// android/app/src/main/assets/tools/ui-form.js; `npm run compile` copies it to out/ui-form-core.js
// (scripts/copy-ui-form.js). This file only adds the types. Free of `vscode` so it runs under node --test.

export type FieldKind = "text" | "password" | "textarea" | "number" | "checkbox" | "select" | "radio" | "label";

export interface Field {
  kind: FieldKind;
  /** Key in the returned dict (Python identifier). Ignored for "label". */
  id: string;
  label: string;
  /** str for text-like/select/radio, number for number, boolean for checkbox. */
  default?: string | number | boolean;
  /** select / radio choices. */
  options?: string[];
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
  required?: boolean;
}

export interface FormSpec {
  version: 1;
  title: string;
  submit: string;
  cancel?: string;
  /** Window size, CSS units ui.Window accepts (e.g. "85vw"). */
  width: string;
  height: string;
  fields: Field[];
}

interface Core {
  FIELD_KINDS: FieldKind[];
  INIT_MARKER: string;
  newSpec(title?: string): FormSpec;
  newField(kind: FieldKind, spec: FormSpec): Field;
  validateSpec(spec: FormSpec): string[];
  parseSpec(text: string): FormSpec;
  defaults(spec: FormSpec): Record<string, string | number | boolean>;
  renderHtml(spec: FormSpec): string;
  renderPython(spec: FormSpec, htmlRel: string): string;
  outputs(spec: FormSpec, name: string): Record<string, string>;
  formName(file: string): string | undefined;
  serializeSpec(spec: FormSpec): string;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const core: Core = require("./ui-form-core");

export const FIELD_KINDS = core.FIELD_KINDS;
/** The page shown by ui.Window. Submitting calls xscript.call("submit", <JSON of the values>); cancel closes.
 * The generated Python swaps INIT_MARKER for the script's current values before showing it. */
export const INIT_MARKER = core.INIT_MARKER;
export const newSpec = core.newSpec;
/** Default-ish new field of a kind with a free id (field1, field2, ...). */
export const newField = core.newField;
/** Problems that would make the generated code wrong; empty when the spec is fine. */
export const validateSpec = core.validateSpec;
/** Normalised copy (types coerced) so JSON written by hand still generates sane code. */
export const parseSpec = core.parseSpec;
export const defaults = core.defaults;
export const renderHtml = core.renderHtml;
/** res/ui/<name>.py lives next to the entry as ui_<name>.py. */
export const renderPython = core.renderPython;
/** Files written for a spec saved at res/ui/<name>.ui.json (paths relative to the project root). */
export const outputs = core.outputs;
/** "res/ui/main.ui.json" -> "main"; undefined when the file is not a form spec. */
export const formName = core.formName;
/** Pretty JSON as stored on disk (stable so undo/redo and git diffs stay small). */
export const serializeSpec = core.serializeSpec;
