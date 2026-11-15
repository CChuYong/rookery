import { forwardRef } from "react";
import type { InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn.js";

// Single source of truth for form-field geometry + the orange focus ring. Before this, every <select>/<textarea> was an
// inline string that drifted (and often dropped the ring / used a different disabled opacity). Sizes preserve the existing
// heights (xs = composer controls, sm = spawn modal, md = inputs/settings).
// Quiet IDE-style field: flat ink background, hairline border, a neutral (not orange) focus ring — the accent is
// reserved for lines/focus-markers elsewhere, not for every field's focus state.
const field = cva(
  "rounded-sm border border-line bg-ink text-fg placeholder:text-faint transition-colors hover:border-thumb-hi focus:border-fg/30 focus:outline-none focus-visible:outline-none focus:ring-1 focus:ring-fg/10 disabled:cursor-not-allowed disabled:opacity-40",
  {
    variants: {
      size: {
        xs: "h-7 px-2 text-ui bg-transparent [field-sizing:content]",
        sm: "h-7 px-2 text-ui",
        md: "h-7 px-2.5 text-body",
      },
    },
    defaultVariants: { size: "md" },
  },
);

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size">, VariantProps<typeof field> {}
// forwardRef so a form can move focus to a field (the spawn page focuses an invalid budget).
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ className, size, ...props }, ref) {
  return <input ref={ref} className={cn(field({ size }), className)} {...props} />;
});

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "size">, VariantProps<typeof field> {}
export function Select({ className, size, ...props }: SelectProps): JSX.Element {
  return <select className={cn(field({ size }), "cursor-pointer", className)} {...props} />;
}

export interface TextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "size">, VariantProps<typeof field> {}
export function Textarea({ className, size, ...props }: TextareaProps): JSX.Element {
  // height is caller-controlled (rows / min-h) → drop the size h-*; keep the field's border/ring/padding-x + text size.
  return <textarea className={cn(field({ size }), "h-auto py-1.5 leading-relaxed", className)} {...props} />;
}
