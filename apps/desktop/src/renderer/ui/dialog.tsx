import { cn } from "../lib/cn.js";

// The one dialog shell (audit #102). Every modal panel shares the same chrome — 8px radius, one hairline, the lifted
// surface, the popover shadow, 20px padding — and one of two widths: sm (360px) for confirms and short prompts, md
// (480px) for small forms. Large builders (Skill import, MCP pack) keep their own width but the same chrome.
export type DialogSize = "sm" | "md";

const WIDTH: Record<DialogSize, string> = {
  sm: "w-[360px]",
  md: "w-[480px]",
};

export function dialogPanelClass({ size = "sm", closing = false, padded = true, className }: { size?: DialogSize; closing?: boolean; padded?: boolean; className?: string } = {}): string {
  return cn(
    "max-w-[calc(100vw-2rem)] rounded-xl border border-line bg-surface shadow-pop",
    WIDTH[size],
    padded && "p-5",
    closing ? "motion-safe:animate-[dialog-out_140ms_ease-in]" : "motion-safe:animate-[dialog-in_160ms_ease-out]",
    className,
  );
}

// The scrim behind a dialog. `z` stays per call site: confirms stack above other modals (z-[110]).
export function dialogOverlayClass({ closing = false, z = "z-50" }: { closing?: boolean; z?: string } = {}): string {
  return cn(
    "fixed inset-0 flex items-center justify-center bg-scrim p-4",
    z,
    closing ? "motion-safe:animate-[overlay-out_130ms_ease-in]" : "motion-safe:animate-[overlay-in_140ms_ease-out]",
  );
}
