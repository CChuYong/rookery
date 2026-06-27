import { memo, useState } from "react";
import { Copy, Check } from "lucide-react";
import { Markdown, StreamingMarkdown } from "./Markdown.js";
import { cn } from "../lib/cn.js";
import { relativeTime, absoluteDate } from "../lib/relative-time.js";
import { useT, useLocale } from "../i18n/provider.js";
import type { TFunc } from "../i18n/provider.js";
import type { Locale } from "../i18n/types.js";

// Turn ts (arrival epoch ms) into a label shown on hover. Within 7 days, relative time (i18n); beyond that, absolute date.
function timeLabel(ts: number, now: number, t: TFunc, locale: Locale): string {
  const rel = relativeTime(ts, now);
  if (!rel) return absoluteDate(ts, now, locale);
  if (rel.unit === "now") return t("relativeTime.justNow");
  if (rel.unit === "m") return t("relativeTime.minutesAgo", { n: rel.value });
  if (rel.unit === "h") return t("relativeTime.hoursAgo", { n: rel.value });
  return t("relativeTime.daysAgo", { n: rel.value });
}

// Agent (master) message block — full-width markdown with no bubble. On hover, a copy button appears below that copies the
// original content to the clipboard. To its right, the arrival relative time (when ts is present). While streaming (incomplete), both are hidden.
function AssistantMessageImpl({ content, streaming, ts, className }: { content: string; streaming?: boolean; ts?: number; className?: string }): JSX.Element {
  const t = useT();
  const locale = useLocale();
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    void navigator.clipboard
      .writeText(content)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500); // brief ✓ feedback, then revert
      })
      .catch(() => {});
  };
  const hasTs = typeof ts === "number" && Number.isFinite(ts);
  return (
    <div aria-busy={streaming || undefined} className={cn("group w-full [overflow-wrap:anywhere] px-0.5 text-[13.5px] leading-relaxed text-fg", className)}>
      {streaming ? <StreamingMarkdown content={content} /> : <Markdown>{content}</Markdown>}
      {!streaming && (
        // Fixed height (prevents layout jump) + revealed only on hover.
        <div className="mt-1 flex h-5 items-center gap-1.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <button
            onClick={copy}
            title={copied ? t("assistantMessage.copied") : t("assistantMessage.copy")}
            aria-label={t("assistantMessage.copyMessage")}
            className="flex h-5 w-5 items-center justify-center rounded-md text-muted transition-colors hover:bg-raised hover:text-fg-dim"
          >
            {/* the key flip remounts the icon so dot-pop re-runs on each copy — the boolean-flip vocabulary for the literal success flip */}
            {copied ? <Check key="ok" size={13} className="text-pr dot-pop" /> : <Copy key="copy" size={13} />}
          </button>
          <span className="sr-only" role="status" aria-live="polite">{copied ? t("assistantMessage.copied") : ""}</span>
          {hasTs && (
            <time
              dateTime={new Date(ts).toISOString()}
              title={new Date(ts).toLocaleString(locale)}
              className="select-none text-[11px] tabular-nums text-muted"
            >
              {timeLabel(ts, Date.now(), t, locale)}
            </time>
          )}
        </div>
      )}
    </div>
  );
}

export const AssistantMessage = memo(AssistantMessageImpl);
AssistantMessage.displayName = "AssistantMessage";
