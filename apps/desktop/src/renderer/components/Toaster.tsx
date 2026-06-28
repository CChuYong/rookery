import { createPortal } from "react-dom";
import { useCallback, useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { useToastStore } from "../store/toasts.js";
import type { Toast, ToastKind } from "../store/toasts.js";
import { useDismissTransition } from "../lib/useDismissTransition.js";
import { useT } from "../i18n/provider.js";
import { cn } from "../lib/cn.js";

const ICON: Record<ToastKind, typeof AlertCircle> = { error: AlertCircle, success: CheckCircle2, info: Info };
const BOX: Record<ToastKind, string> = {
  error: "border-fail/40 bg-fail/12",
  success: "border-pr/40 bg-pr/12",
  info: "border-line bg-raised",
};
const ICON_TONE: Record<ToastKind, string> = { error: "text-fail", success: "text-pr", info: "text-fg-dim" };
const TTL: Record<ToastKind, number> = { error: 7000, success: 4500, info: 4500 };

function ToastRow({ toast }: { toast: Toast }): JSX.Element {
  const t = useT();
  const dismiss = useToastStore((s) => s.dismiss);
  // Stable onClose (dismiss is a stable store fn, toast.id is fixed) → animateOut keeps a stable identity, so the
  // auto-expire effect below doesn't re-run (clear+reset the TTL timer) on every unrelated re-render — e.g. when a
  // sibling toast is pushed and the whole stack re-renders. Without this the timer never fires under activity.
  const onClose = useCallback(() => dismiss(toast.id), [dismiss, toast.id]);
  const { closing, dismiss: animateOut } = useDismissTransition(onClose, 140);
  const [hovering, setHovering] = useState(false);
  // Auto-expire, paused while hovered (the effect re-arms a fresh TTL whenever hover ends). No timer while hovering or closing.
  useEffect(() => {
    if (closing || hovering) return;
    const id = setTimeout(animateOut, TTL[toast.kind]);
    return () => clearTimeout(id);
  }, [closing, hovering, animateOut, toast.kind]);
  const Icon = ICON[toast.kind];
  return (
    <div
      // error → alert (assertive); others → status (polite). The role implies the live-region politeness.
      role={toast.kind === "error" ? "alert" : "status"}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      className={cn(
        "pointer-events-auto flex w-[340px] items-start gap-2 rounded-xl border px-3 py-2.5 text-xs shadow-lg backdrop-blur-sm",
        BOX[toast.kind],
        closing ? "motion-safe:animate-[dialog-out_140ms_ease-in]" : "rise-in",
      )}
    >
      <Icon size={15} className={cn("mt-px shrink-0 badge-pop", ICON_TONE[toast.kind])} />
      <div className="min-w-0 flex-1">
        <div className="font-medium leading-snug text-fg">{toast.text}</div>
        {toast.detail && <div className="mt-0.5 truncate font-mono text-[11px] text-muted" title={toast.detail}>{toast.detail}</div>}
      </div>
      <button onClick={animateOut} aria-label={t("common.close")} className="-mr-1 shrink-0 rounded p-0.5 text-muted transition-colors hover:text-fg"><X size={13} /></button>
    </div>
  );
}

// Bottom-right toast stack. pointer-events-none on the container (clicks pass through the gaps); each toast re-enables them.
// flex-col-reverse so the newest sits at the bottom and pushes older ones up.
export function Toaster(): JSX.Element | null {
  const toasts = useToastStore((s) => s.toasts);
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="pointer-events-none fixed bottom-4 right-4 z-[120] flex flex-col-reverse gap-2">
      {toasts.map((toast) => (
        <ToastRow key={toast.id} toast={toast} />
      ))}
    </div>,
    document.body,
  );
}
