import type { ComponentProps } from "react";
import { t } from "../strings";
import { Dialog } from "./ui/dialog";

export { isModalOpen } from "./ui/dialog";

/** The shared `Dialog` with the shell's own close label (kept for the confirm dialog and other existing callers). */
export function Overlay(props: Omit<ComponentProps<typeof Dialog>, "closeLabel">) {
  return <Dialog closeLabel={t.shortcuts.close} {...props} />;
}
