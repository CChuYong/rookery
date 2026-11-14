import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// The renderer's type scale (globals.css @theme --text-meta/ui/body/prose/title) uses custom font-size names that
// tailwind-merge would otherwise read as text *colours* — `cn("text-meta text-muted")` would silently drop the size.
const twMerge = extendTailwindMerge({
  extend: { theme: { text: ["meta", "ui", "body", "prose", "title", "2xs"] } },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
