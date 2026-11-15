import type { ReactNode } from "react";

/** Native disclosure keeps secondary instructions available without taking workspace space. */
export function Disclosure({ title, children }: { title: string; children: ReactNode }) {
  return <details className="ui-disclosure"><summary>{title}</summary><div>{children}</div></details>;
}
