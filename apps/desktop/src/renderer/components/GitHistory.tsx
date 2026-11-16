import { useEffect, useState } from "react";
import { useWsStore } from "../store/workspace.js";
import { SkeletonRows } from "./Skeleton.js";
import { LoadFailed, EmptyState } from "../ui/load-state.js";
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
// Reloads when HEAD moves (`head`, from the Changes poll — catches commits a file watch can't see in a worktree) and
// on the panel's refresh button (`refreshKey`), keeping the old list on screen meanwhile (audit #40).
export function GitHistory({ root, pageKey, version = 0, head = null, refreshKey = 0 }: { root: string; pageKey: string; version?: number; head?: string | null; refreshKey?: number }): JSX.Element {
  const t = useT();
  const locale = useLocale();
  const [commits, setCommits] = useState<Commit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const openCommit = useWsStore((s) => s.openCommit_);
  const load = (live: () => boolean): Promise<void> =>
    window.rookery.ws.gitLog(root, 80).then(
      (c) => { if (live()) { setCommits(c); setError(null); } },
      (e: unknown) => {
        if (!live()) return;
        const text = (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
        setError(text);
        throw new Error(text);
      },
    );
  useEffect(() => {
    let live = true;
    void load(() => live).catch(() => {});
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, version, head, refreshKey]);
  useEffect(() => { setCommits(null); setError(null); }, [root]);
  if (!commits && error) return <LoadFailed message={t("gitHistory.loadFailed")} detail={error} onRetry={() => load(() => true)} />;
  if (!commits) return <SkeletonRows rows={8} />;
  if (commits.length === 0) return <EmptyState>{t("gitHistory.noCommits")}</EmptyState>;
  return (
    <div className="py-1">
      {commits.map((c) => (
        <button key={c.hash} onClick={() => openCommit(pageKey, c.hash, c.subject)} className="flex w-full min-w-0 flex-col gap-0.5 overflow-hidden rounded px-2.5 py-1.5 text-left hover:bg-raised">
          <span className="block max-w-full truncate text-body text-fg-dim" title={c.subject}>{c.subject}</span>
          <span className="flex min-w-0 max-w-full items-center gap-1.5 text-meta text-muted">
            <span className="shrink-0 font-mono text-muted/80">{c.shortHash}</span>
            <span className="h-3 w-px shrink-0 bg-line" aria-hidden />
            <span className="min-w-0 truncate">{c.author}</span>
            <span className="h-3 w-px shrink-0 bg-line" aria-hidden />
            <span className="shrink-0">{commitDateLabel(c.date, Date.now(), t, locale)}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
