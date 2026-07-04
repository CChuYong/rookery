import type { ButtonHTMLAttributes } from "react";
import { Loader2 } from "lucide-react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn.js";

const button = cva(
  "inline-flex items-center justify-center gap-1.5 rounded-[var(--radius)] font-medium whitespace-nowrap transition-[color,background-color,border-color,transform] duration-150 active:scale-[0.97] motion-reduce:active:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-0 disabled:opacity-40 disabled:pointer-events-none select-none",
  {
    variants: {
      variant: {
        primary:
          "bg-accent text-accent-ink hover:bg-accent-hi shadow-[0_1px_0_rgba(255,255,255,0.08)_inset] disabled:bg-raised disabled:text-muted disabled:opacity-100",
        ghost: "text-fg-dim hover:bg-raised hover:text-fg",
        outline: "border border-line text-fg-dim hover:bg-raised hover:text-fg hover:border-fg-dim/40",
        danger: "text-fail/80 hover:bg-fail/10 hover:text-fail",
        // Solid destructive action (audit #73) — distinct from `danger` above (which stays the existing
        // subtle ghost-style used by Composer's Stop / InteractionCard's Deny) so those two callers are
        // untouched. This is the "primary, but red" counterpart used for ConfirmDialog's destructive confirm.
        dangerSolid:
          "bg-fail/90 text-fg hover:bg-fail shadow-[0_1px_0_rgba(255,255,255,0.08)_inset] disabled:bg-raised disabled:text-muted disabled:opacity-100",
        chip: "border border-line/80 text-fg-dim hover:border-accent/40 hover:text-fg",
      },
      size: {
        sm: "h-7 px-2.5 text-[12px]",
        md: "h-9 px-3.5 text-[13px]",
        icon: "h-9 w-9 p-0",
        iconSm: "h-7 w-7 p-0",
      },
    },
    defaultVariants: { variant: "ghost", size: "md" },
  },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof button> {
  loading?: boolean; // in-flight: shows a spinner (replacing the content) + aria-busy and is disabled (prevents double-submit)
}

export function Button({ className, variant, size, loading, disabled, type, children, ...props }: ButtonProps): JSX.Element {
  return (
    <button
      // default type=button so a Button never accidentally submits a surrounding form (the app uses onClick handlers).
      type={type ?? "button"}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      className={cn(button({ variant, size }), className)}
      {...props}
    >
      {loading ? <Loader2 className="animate-spin motion-reduce:hidden" size={15} aria-hidden /> : children}
    </button>
  );
}
