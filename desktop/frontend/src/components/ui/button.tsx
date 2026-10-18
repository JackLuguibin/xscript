import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

const buttonVariants = cva(
  "inline-flex cursor-pointer items-center whitespace-nowrap disabled:cursor-not-allowed",
  {
    variants: {
      variant: {
        default:
          "min-h-8 justify-center gap-sp-2 rounded-sm border border-line-strong bg-surface px-sp-3 py-sp-1 text-fg transition-[background,border-color,transform] duration-fast ease-snap hover:border-primary hover:bg-surface-2 active:translate-y-px active:scale-[0.985] disabled:opacity-55",
        primary:
          "min-h-8 justify-center gap-sp-2 rounded-sm border border-primary bg-primary px-sp-3 py-sp-1 font-semibold text-on-primary transition-[background,border-color,transform] duration-fast ease-snap hover:border-primary-hover hover:bg-primary-hover active:translate-y-px active:scale-[0.985] disabled:opacity-55",
        ghost:
          "min-h-8 justify-center gap-sp-2 rounded-sm border border-transparent bg-transparent px-sp-3 py-sp-1 text-fg transition-[background,border-color,transform] duration-fast ease-snap hover:bg-surface-2 active:translate-y-px active:scale-[0.985] disabled:opacity-55",
        danger:
          "min-h-8 justify-center gap-sp-2 rounded-sm border border-line-strong bg-surface px-sp-3 py-sp-1 text-danger-fg transition-[background,border-color,transform] duration-fast ease-snap hover:border-danger-dot hover:bg-danger-bg active:translate-y-px active:scale-[0.985] disabled:opacity-55",
        /* No chrome: the className is the whole style (tree rows, canvas chrome). */
        bare: "",
        /* Layout stays in components.css (.nav-item, collapsed rail, forced-colors). */
        nav: "nav-item",
      },
      size: {
        default: "",
        sm: "min-h-7 px-sp-2 text-sm",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants> & { asChild?: boolean };

export function Button({ className, variant, size, asChild = false, type, ...props }: ButtonProps) {
  const classes = cn(buttonVariants({ variant, size }), className);
  if (asChild) return <Slot className={classes} {...props} />;
  return <button className={classes} type={type ?? "button"} {...props} />;
}
