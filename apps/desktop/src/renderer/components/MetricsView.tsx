import type { LogItem } from "../store/reduce.js";
import { fmtTokens, fmtUsd, ctxTone } from "../format.js";
import { cn } from "../lib/cn.js";
import { useT } from "../i18n/provider.js";

// Renders the metrics segment — finds the last metrics item in the LogItem array and shows ctx%/tok/turns/cost.
// Shared by both the session header (SessionMetrics) and the worker header (WorkerMetrics).
export function MetricsView({ items }: { items: LogItem[] }): JSX.Element | null {
  const t = useT();
  const m = [...items].reverse().find((it) => it.kind === "metrics") as
    | { kind: "metrics"; contextPct: number; tokens: number; turns: number; durationMs: number; cost: number; terminalReason?: string }
    | undefined;
  if (!m) return null;
  return (
    <span className="flex items-center gap-2 font-mono text-[11px] text-muted">
      <span className={cn("inline-flex items-baseline gap-1", ctxTone(m.contextPct))}>{m.contextPct}% <span className="text-[9px] text-muted/70">ctx</span></span>
      <span>·</span>
      <span>{fmtTokens(m.tokens)} tok</span>
      <span>·</span>
      <span>{t("sessionMetrics.turns", { count: m.turns })}</span>
      <span>·</span>
      <span>{fmtUsd(m.cost)}</span>
      {m.terminalReason && (
        <>
          <span>·</span>
          <span className="text-fail" title={t("sessionMetrics.terminalReason")}>⚠ {m.terminalReason}</span>
        </>
      )}
    </span>
  );
}
