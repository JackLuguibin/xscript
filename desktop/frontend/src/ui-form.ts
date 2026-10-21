// Typed entry to the UI designer core shared with VS Code and the Web IDE (android/app/src/main/assets/tools/ui-form.js).
// src/vendor/ui-form.js is a verbatim copy; tests/ui-form.test.ts fails when it drifts from the source.
import * as vendored from "./vendor/ui-form.js";

export type FieldKind = "text" | "password" | "textarea" | "number" | "checkbox" | "select" | "radio" | "label";

export interface UiField {
  kind: FieldKind;
  id: string;
  label: string;
  default?: string | number | boolean;
  options?: string[];
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
  required?: boolean;
}

export interface UiSpec {
  version: 1;
  title: string;
  submit: string;
  cancel?: string;
  width: string;
  height: string;
  fields: UiField[];
}

export interface UiFormCore {
  FIELD_KINDS: FieldKind[];
  INIT_MARKER: string;
  newSpec(title?: string): UiSpec;
  newField(kind: FieldKind, spec: UiSpec): UiField;
  validateSpec(spec: UiSpec): string[];
  parseSpec(text: string): UiSpec;
  defaults(spec: UiSpec): Record<string, string | number | boolean>;
  renderHtml(spec: UiSpec): string;
  renderPython(spec: UiSpec, htmlRel: string): string;
  /** Generated files (relative path -> content) for res/ui/<name>.ui.json. */
  outputs(spec: UiSpec, name: string): Record<string, string>;
  formName(file: string): string | undefined;
  serializeSpec(spec: UiSpec): string;
}

type Holder = { XSUiForm?: UiFormCore };
// The core is a UMD-style script: in the page it attaches to `window`; where `module` exists (vitest) it is module.exports.
const viaModule = (vendored as unknown as { default?: UiFormCore }).default;
export const uiForm = (viaModule?.newSpec ? viaModule : ((typeof window !== "undefined" ? (window as unknown as Holder).XSUiForm : undefined) ?? (globalThis as unknown as Holder).XSUiForm)) as UiFormCore;
