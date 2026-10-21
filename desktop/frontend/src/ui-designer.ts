// Typed entry to the UI designer view shared with VS Code and the Web IDE (android/app/src/main/assets/tools/ui-designer.js).
// src/vendor/ui-designer.js is a verbatim copy; tests/ui-form.test.ts fails when it drifts from the source.
import "./ui-form";
import * as vendored from "./vendor/ui-designer.js";
import type { UiFormCore, UiSpec } from "./ui-form";

export type DesignerIn = { type: "spec"; spec: UiSpec; errors: string[]; preview: string } | { type: "error"; error: string };
export type DesignerOut = { type: "edit"; spec: UiSpec };

export interface DesignerHandle {
  receive(m: DesignerIn): void;
  readonly selected: number;
}

export interface UiDesignerCore {
  mount(app: HTMLElement, opts: { lang: "zh" | "en"; post: (m: DesignerOut) => void; form?: UiFormCore }): DesignerHandle;
  messageFor(text: string, form?: UiFormCore, invalidHint?: string): DesignerIn;
}

type Holder = { XSUiDesigner?: UiDesignerCore };
const viaModule = (vendored as unknown as { default?: UiDesignerCore }).default;
export const uiDesigner = (viaModule?.mount ? viaModule : ((typeof window !== "undefined" ? (window as unknown as Holder).XSUiDesigner : undefined) ?? (globalThis as unknown as Holder).XSUiDesigner)) as UiDesignerCore;
