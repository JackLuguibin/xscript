import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

/* The look lives in styles/ui.css (the `ui` cascade layer), so component rules can restyle a primitive in context and
   utilities passed as className still win. bare and nav carry no look of their own. */
const buttonVariants = cva("ui-btn", {
  variants: {
    variant: {
      default: "ui-btn-default",
      primary: "ui-btn-primary",
      ghost: "ui-btn-ghost",
      danger: "ui-btn-danger",
      /* Flow canvas toolbar: flat, compact; toolbarPrimary / toolbarDanger keep the intent. */
      toolbar: "ui-btn-toolbar",
      toolbarPrimary: "ui-btn-toolbar-primary",
      toolbarDanger: "ui-btn-toolbar-danger",
      /* No chrome: the className is the whole style (tree rows, canvas chrome). */
      bare: "",
      /* Layout stays in components.css (.nav-item, collapsed rail, forced-colors). */
      nav: "nav-item",
    },
    size: {
      default: "",
      sm: "ui-btn-sm",
      /* Square icon button; aria-pressed marks a toggle that is on. */
      icon: "ui-btn-icon",
    },
  },
  defaultVariants: { variant: "default", size: "default" },
});

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants> & { asChild?: boolean };

export function Button({ className, variant, size, asChild = false, type, ...props }: ButtonProps) {
  const classes = cn(buttonVariants({ variant, size }), className);
  if (asChild) return <Slot className={classes} {...props} />;
  return <button className={classes} type={type ?? "button"} {...props} />;
}
