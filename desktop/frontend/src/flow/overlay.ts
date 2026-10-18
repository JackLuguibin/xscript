import type { NodeSpec } from "./dsl";

export interface OverlayPin {
  name: string;
  type?: string;
  ui?: string;
  min?: number;
  default?: string | number | boolean | null;
}

/** A hand refinement layered on a generated spec. It does not replace the compile template. */
export interface OverlayPatch {
  type: string;
  title?: { zh: string; en: string };
  doc?: { zh: string; en: string };
  icon?: string;
  category?: string;
  latent?: boolean;
  inputs?: OverlayPin[];
}

export function applyOverlay<T extends NodeSpec & { type: string }>(base: T, patch: OverlayPatch): T {
  const inputs = base.inputs.map((pin) => {
    const over = patch.inputs?.find((item) => item.name === pin.name);
    if (!over) return pin;
    return { ...pin, ...over, name: pin.name };
  });
  return {
    ...base,
    title: patch.title ?? base.title,
    doc: patch.doc ?? base.doc,
    icon: patch.icon ?? base.icon,
    category: patch.category ?? base.category,
    latent: patch.latent ?? base.latent,
    inputs,
  };
}
