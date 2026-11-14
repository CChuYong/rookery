import type { ButtonHTMLAttributes } from "react";
import { Loader2 } from "lucide-react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn.js";

const button = cva(
  "inline-flex items-center justify-center gap-1.5 rounded-sm font-medium whitespace-nowrap transition-[color,background-color,border-color,transform] duration-[var(--dur-micro)] active:scale-[0.98] motion-reduce:active:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hi focus-visible:ring-offset-2 focus-visible:ring-offset-ink disabled:opacity-40 disabled:pointer-events-none select-none",
  {
    variants: {
      variant: {
        // Neutral fill (IDE primary, e.g. T3/Orca) — the orange accent is reserved for lines/focus/markers, not button fills.
        primary: "bg-fg text-ink hover:bg-fg-dim disabled:bg-raised disabled:text-muted disabled:opacity-100",
        ghost: "text-muted hover:bg-raised hover:text-fg",
        outline: "border border-line text-fg-dim hover:bg-raised hover:text-fg",
        danger: "text-fail/85 hover:bg-fail/10 hover:text-fail",
        // Solid destructive action (audit #73) — distinct from `danger` above (which stays the subtle ghost-style
        // used by Composer's Stop / InteractionCard's Deny). The "primary, but red" confirm for ConfirmDialog.
        dangerSolid: "bg-fail text-accent-ink hover:bg-fail/90 disabled:bg-raised disabled:text-muted disabled:opacity-100",
        chip: "border border-line text-fg-dim hover:bg-raised hover:text-fg",
      },
      size: {
        sm: "h-6 px-2.5 text-ui",
        md: "h-7 px-3 text-body",
        icon: "h-7 w-7 p-0",
        iconSm: "h-6 w-6 p-0",
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
      {loading ? <Loader2 className="animate-spin motion-reduce:hidden" size={14} aria-hidden /> : children}
    </button>
  );
}
