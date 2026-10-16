import type { ReactNode } from "react";

export type BadgeTone = "ok" | "bad" | "warn" | "neutral";

/** Status pill: colour is never the only signal — there is always the text, and the dot is decorative. */
export function Badge({ tone = "neutral", busy = false, children }: { tone?: BadgeTone; busy?: boolean; children: ReactNode }) {
  return (
    <span className={`badge ${tone}${busy ? " busy" : ""}`}>
      <span className="dot" aria-hidden="true" />
      {children}
    </span>
  );
}
