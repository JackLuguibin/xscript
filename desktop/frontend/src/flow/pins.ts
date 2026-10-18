/** UE-style pin hues from the desktop design. Exec is white; data follows the type. */

const TONES = ["exec", "bool", "int", "float", "string", "point", "rect", "color", "image", "node", "dict", "json", "any"] as const;

export function pinTone(type: string | undefined): string {
  const raw = (type ?? "any").trim();
  const list = /^list<(.+)>$/.exec(raw);
  const base = (list ? list[1] : raw).replace(/\?$/, "");
  if ((TONES as readonly string[]).includes(base)) return base;
  return "any";
}

/** List pins are square. Optional pins carry a dot. The type text is the non-color cue. */
export function pinMarks(type: string | undefined): { list: boolean; optional: boolean } {
  const raw = (type ?? "").trim();
  const list = /^list<(.+)>$/.exec(raw);
  const inner = (list ? list[1] : raw).trim();
  return { list: Boolean(list), optional: inner.endsWith("?") };
}

export function dataPinClass(type: string | undefined, wired: boolean): string {
  const marks = pinMarks(type);
  return ["handle-data", "tone-" + pinTone(type), wired ? "is-wired" : "is-open", marks.list ? "is-list" : "", marks.optional ? "is-optional" : ""].filter(Boolean).join(" ");
}

export function pinColor(type: string | undefined): string {
  switch (pinTone(type)) {
    case "exec":
      return "#f4f4f5";
    case "bool":
      return "#a12b3a";
    case "int":
      return "#1f9d8a";
    case "float":
      return "#9dbb2f";
    case "string":
      return "#d24b9a";
    case "point":
      return "#d4a017";
    case "rect":
      return "#e07a2f";
    case "color":
      return "#2f4f9a";
    case "image":
      return "#7a4ea3";
    case "node":
      return "#3aa0d8";
    case "dict":
    case "json":
      return "#c47a3a";
    default:
      return "#8a8a8a";
  }
}
