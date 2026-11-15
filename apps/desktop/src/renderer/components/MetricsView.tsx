import { costQuality } from "../lib/cost.js";
import type { LogItem } from "../store/reduce.js";
import { fmtTokens, fmtUsd, ctxTone } from "../format.js";
import { cn } from "../lib/cn.js";
import { useT } from "../i18n/provider.js";

// Renders the metrics segment — finds the last metrics item in the LogItem array and shows ctx%/tok/turns/cost.
// Shared by both the session header (SessionMetrics) and the worker header (WorkerMetrics). Everything but ctx% carries
// `metrics-secondary`, which a narrow header drops (globals.css) so the context pressure stays visible (audit #21).
export function MetricsView({ items, provider }: { items: LogItem[]; provider?: string }): JSX.Element | null {
  const t = useT();
  const m = [...items].reverse().find((it) => it.kind === "metrics") as
    | Extract<LogItem, { kind: "metrics" }>
    | undefined;
  if (!m) return null;
  const quality = costQuality(m.costAccuracy, undefined, provider);
  // An errored/aborted result can report zero usage — keep the last real context reading instead of showing 0%/0 tok.
  const ctx = m.tokens > 0 ? m : ([...items].reverse().find((it) => it.kind === "metrics" && (it as { tokens: number }).tokens > 0) as typeof m | undefined) ?? m;
  // "completed" is the SDK's normal terminal reason; only other reasons (api_error, max_turns, …) are worth flagging.
  const reason = m.terminalReason && m.terminalReason !== "completed" ? m.terminalReason : undefined;
  // Known SDK terminal reasons get a localized label (audit #124); an unknown code is shown as-is. The raw code stays
  // in the title so a bug report can still quote it.
  const reasonKey = reason ? `sessionMetrics.reason_${reason}` : undefined;
  const reasonText = reasonKey ? (t(reasonKey) === reasonKey ? reason : t(reasonKey)) : undefined;
  return (
    <span className="flex items-center gap-2.5 text-meta text-muted">
      <span className={cn("inline-flex items-baseline gap-1", ctxTone(ctx.contextPct))} title={t("sessionMetrics.ctxTitle")}>
        <span className="tabular-nums">{ctx.contextPct}%</span>
        <span className="text-meta text-muted/70">{t("sessionMetrics.ctx")}</span>
      </span>
      <span className="metrics-secondary tabular-nums" title={t("sessionMetrics.tokTitle")}>{t("sessionMetrics.tok", { count: fmtTokens(ctx.tokens) })}</span>
      <span className="metrics-secondary tabular-nums" title={t("sessionMetrics.turnsTitle")}>{t("sessionMetrics.turns", { count: m.turns })}</span>
      <span className="metrics-secondary tabular-nums" title={t("sessionMetrics.costTitle")} aria-label={quality === "unavailable" ? t("speed.costUnavailable") : quality === "estimated" ? t("speed.costEstimated") : undefined}>{quality === "unavailable" ? "—" : `${quality === "estimated" ? `${t("speed.estimated")} ` : ""}${fmtUsd(m.cost)}`}</span>
      {reason && (
        <>
          <span className="metrics-secondary h-3 w-px shrink-0 bg-line" aria-hidden />
          <span className="metrics-secondary text-fail" title={`${t("sessionMetrics.terminalReason")} · ${reason}`}>⚠ {reasonText}</span>
        </>
      )}
    </span>
  );
}
