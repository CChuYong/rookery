import { useEffect, useState } from "react";
import { useWsStore } from "../store/workspace.js";
import { SkeletonRows } from "./Skeleton.js";
import { useT, useLocale } from "../i18n/provider.js";
import type { TFunc } from "../i18n/provider.js";
import type { Locale } from "../i18n/types.js";
import { relativeTime, absoluteDate } from "../lib/relative-time.js";

type Commit = { hash: string; shortHash: string; subject: string; author: string; date: number };

// Turn a commit date (unix seconds, %ct — locale-independent) into a label that follows the app locale.
// Within 7 days, relative time (i18n); beyond that, absolute date. Same convention as AssistantMessage's timeLabel.
function commitDateLabel(dateSeconds: number, now: number, t: TFunc, locale: Locale): string {
  const ts = dateSeconds * 1000;
  const rel = relativeTime(ts, now);
  if (!rel) return absoluteDate(ts, now, locale);
  if (rel.unit === "now") return t("relativeTime.justNow");
  if (rel.unit === "m") return t("relativeTime.minutesAgo", { n: rel.value });
  if (rel.unit === "h") return t("relativeTime.hoursAgo", { n: rel.value });
  return t("relativeTime.daysAgo", { n: rel.value });
}

// Recent commit history list. Clicking a row → opens that commit's multi-file Diff page (commit tab).
export function GitHistory({ root, pageKey, version = 0 }: { root: string; pageKey: string; version?: number }): JSX.Element {
  const t = useT();
  const locale = useLocale();
  const [commits, setCommits] = useState<Commit[] | null>(null);
  const openCommit = useWsStore((s) => s.openCommit_);
  useEffect(() => {
    let live = true;
    void window.rookery.ws.gitLog(root, 80).then((c) => { if (live) setCommits(c); });
    return () => { live = false; };
  }, [root, version]);
  if (!commits) return <SkeletonRows rows={8} />;
  if (commits.length === 0) return <div className="px-3 py-3 text-[12px] text-muted">{t("gitHistory.noCommits")}</div>;
  return (
    <div className="py-1">
      {commits.map((c) => (
        <button key={c.hash} onClick={() => openCommit(pageKey, c.hash, c.subject)} className="flex w-full min-w-0 flex-col gap-0.5 overflow-hidden rounded px-2.5 py-1.5 text-left hover:bg-raised">
          <span className="block max-w-full truncate text-[12px] text-fg-dim" title={c.subject}>{c.subject}</span>
          <span className="flex min-w-0 max-w-full items-center gap-1.5 text-[10px] text-muted">
            <span className="shrink-0 font-mono text-muted/80">{c.shortHash}</span>
            <span className="shrink-0">·</span>
            <span className="min-w-0 truncate">{c.author}</span>
            <span className="shrink-0">·</span>
            <span className="shrink-0">{commitDateLabel(c.date, Date.now(), t, locale)}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
