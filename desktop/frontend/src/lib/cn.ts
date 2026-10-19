import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/* tailwind-merge only knows Tailwind's default scales. Teach it ours (tailwind.css @theme) so `px-sp-3 px-0` keeps the
   later class instead of both, which would leave the winner to stylesheet order. */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      spacing: ["sp-1", "sp-2", "sp-3", "sp-4", "sp-5", "sp-6"],
      radius: ["pill"],
      text: ["md"],
      shadow: ["card", "pop"],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
