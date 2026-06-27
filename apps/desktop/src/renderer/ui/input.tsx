import type { InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn.js";

// Single source of truth for form-field geometry + the coral focus ring. Before this, every <select>/<textarea> was an
// inline string that drifted (and often dropped the ring / used a different disabled opacity). Sizes preserve the existing
// heights (xs = composer controls, sm = spawn modal, md = inputs/settings).
const field = cva(
  "rounded-[var(--radius)] border border-line bg-ink/60 text-fg placeholder:text-muted transition-colors focus:border-accent/60 focus:bg-ink focus:outline-none focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-40 disabled:bg-ink/30",
  {
    variants: {
      size: {
        xs: "h-6 px-1.5 text-[11px]",
        sm: "h-8 px-2 text-[12px]",
        md: "h-9 px-3 text-[13px]",
      },
    },
    defaultVariants: { size: "md" },
  },
);

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size">, VariantProps<typeof field> {}
export function Input({ className, size, ...props }: InputProps): JSX.Element {
  return <input className={cn(field({ size }), className)} {...props} />;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "size">, VariantProps<typeof field> {}
export function Select({ className, size, ...props }: SelectProps): JSX.Element {
  return <select className={cn(field({ size }), "cursor-pointer", className)} {...props} />;
}

export interface TextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "size">, VariantProps<typeof field> {}
export function Textarea({ className, size, ...props }: TextareaProps): JSX.Element {
  // height is caller-controlled (rows / min-h) → drop the size h-*; keep the field's border/ring/padding-x + text size.
  return <textarea className={cn(field({ size }), "h-auto py-1.5 leading-relaxed", className)} {...props} />;
}
