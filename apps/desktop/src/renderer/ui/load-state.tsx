import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { cn } from "../lib/cn.js";
import { useT } from "../i18n/provider.js";
import { Button } from "./button.js";

// Shared loading / empty / failed states (audit T6). A data surface picks one of three states and renders it with
// these, so every panel speaks the same way: loading = `SkeletonRows` (components/Skeleton.tsx), empty = `EmptyState`
// (one 13px muted line + one text button, no glyphs), failed = `LoadFailed` (the reason + a Retry that shows progress
// and, if it fails again, says so instead of silently snapping back to the same row).

type Layout = "row" | "stack";

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === "string" ? e : "";
}

// `onRetry` may return a promise: while it is pending the button is busy, and a rejection is shown under the
// message. A void retry (e.g. one that flips a store flag) can drive the busy state through `retrying` instead.
// `layout`: "row" = message left, button right (sidebar lists, panels); "stack" = centred column (full pages).
export function LoadFailed({ message, detail, onRetry, retrying, retryLabel, layout = "row", className }: {
  message: string;
  detail?: string | null;
  onRetry: () => unknown;
  retrying?: boolean;
  retryLabel?: string;
  layout?: Layout;
  className?: string;
}): JSX.Element {
  const t = useT();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const retry = (): void => {
    let result: unknown;
    try {
      result = onRetry();
    } catch (e) {
      setFailure(errorText(e));
      return;
    }
    if (result && typeof (result as Promise<unknown>).then === "function") {
      setPending(true);
      setFailure(null);
      (result as Promise<unknown>).then(
        () => { if (alive.current) setPending(false); },
        (e: unknown) => { if (alive.current) { setPending(false); setFailure(errorText(e)); } },
      );
    }
  };
  const busy = pending || !!retrying;
  const button = (
    <Button variant="outline" size="sm" loading={busy} onClick={retry} aria-label={retryLabel ?? t("common.retry")} className="shrink-0">
      {retryLabel ?? t("common.retry")}
    </Button>
  );
  const notes = (
    <>
      {detail && <span className="block max-w-xl break-words text-meta text-muted">{detail}</span>}
      {failure !== null && !busy && (
        <span role="status" className="block max-w-xl break-words text-meta text-muted">
          {t("loadState.retryFailed")}{failure ? ` — ${failure}` : ""}
        </span>
      )}
    </>
  );
  if (layout === "stack") {
    return (
      <div className={cn("flex flex-col items-center justify-center gap-2 py-16 text-center", className)}>
        <p className="text-body text-fail">{message}</p>
        {notes}
        <div className="mt-1">{button}</div>
      </div>
    );
  }
  return (
    <div className={cn("flex items-start justify-between gap-2 px-2 py-3 text-ui leading-relaxed", className)}>
      <span className="min-w-0">
        <span className="block text-fail">{message}</span>
        {notes}
      </span>
      {button}
    </div>
  );
}

// One muted 13px line + an optional text button (the IDE empty-state rule: no headings, no glyphs).
export function EmptyState({ children, action, layout = "row", className }: {
  children: ReactNode;
  action?: { label: string; onClick: () => void };
  layout?: Layout;
  className?: string;
}): JSX.Element {
  return (
    <div className={cn(
      "text-body text-muted",
      layout === "stack" ? "flex flex-col items-center justify-center gap-1 py-16 text-center" : "px-3 py-3 leading-relaxed",
      className,
    )}>
      <span>{children}</span>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className={cn("text-body text-fg-dim underline-offset-2 hover:text-fg hover:underline", layout === "row" && "ml-1.5")}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
