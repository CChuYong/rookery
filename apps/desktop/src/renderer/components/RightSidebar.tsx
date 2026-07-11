import { useEffect, useState } from "react";
import { Files, GitBranch, Bot } from "lucide-react";
import { useWsStore } from "../store/workspace.js";
import { useStore } from "../store/store.js";
import { NestedAgents } from "../views/NestedAgents.js";
import { useResizableWidth } from "../lib/useResizableWidth.js";
import { ResizeHandle } from "./ResizeHandle.js";
import { cn } from "../lib/cn.js";
import type { LogItem } from "../store/reduce.js";
import { nestedLabel } from "../lib/nested-label.js";
import { FileTree } from "./FileTree.js";
import { GitChanges } from "./GitChanges.js";
import { SkeletonRows } from "./Skeleton.js";
import { useTreeVersion } from "../lib/useTreeVersion.js";
import { useWorkRoot } from "../lib/useWorkRoot.js";
import { Segment, type SegmentItem } from "../ui/segment.js";
import { useT } from "../i18n/provider.js";

type SegmentKey = "files" | "git" | "worker";

type Nested = { id: string; label: string; items: LogItem[] };

// Stable refs for the nested/workerLogs selectors (creating a fresh empty ref each time would cause infinite re-renders).
const EMPTY_NESTED: Record<string, LogItem[]> = {};
const EMPTY_LOG: LogItem[] = [];

export function RightSidebar({ open, pageKey, subId, cwd, activeTabPath }: { open: boolean; pageKey: string; subId: string | null; cwd?: string; activeTabPath: string | null }): JSX.Element {
  const t = useT();
  const SEGMENTS: Array<SegmentItem<SegmentKey>> = [
    { value: "files", icon: Files, label: t("rightSidebar.segmentFiles"), title: t("rightSidebar.segmentFiles") },
    { value: "git", icon: GitBranch, label: "Git", title: "Git" },
    { value: "worker", icon: Bot, label: t("rightSidebar.segmentWorker"), title: t("rightSidebar.segmentWorker") },
  ];
  const segment = useWsStore((s) => s.right.segment);
  const setSegment = useWsStore((s) => s.setSegment_);
  // Computes the nested agent panels via its own subscription (moves the high-frequency nested/workerLogs reads out of App). No subId means empty panels.
  const nested = useStore((st) => (subId ? st.nested[subId] ?? EMPTY_NESTED : EMPTY_NESTED));
  const workerLog = useStore((st) => (subId ? st.workerLogs[subId] ?? EMPTY_LOG : EMPTY_LOG));
  const nestedPanels: Nested[] = Object.entries(nested).map(([id, items]) => ({ id, label: nestedLabel(workerLog, id), items }));
  // Worker's fleet status: a terminal status (stopped/done/error/failed/orphaned) means the worktree is either
  // already gone or never coming back — feeds useWorkRoot so it short-circuits to `missing` instead of retrying.
  const workerStatus = useStore((st) => (subId ? st.fleet[subId]?.status : undefined));
  // For a worker, only show the files/git of its ACTUAL worktree. resolveWorkRoot falls back to ~/home while `git worktree add`
  // is still running, so without this guard the user would see (and could Cmd+S-edit) their real home files as if they were the
  // worktree. (Sessions have no subId → always ready.)
  const { root, state: rootState } = useWorkRoot({ enabled: true, subId: subId ?? undefined, cwd, status: workerStatus });
  const treeVersion = useTreeVersion(root); // watch the root → increment on change (auto-refresh tree/git)
  const ready = rootState === "ready";
  // While genuinely still resolving (retries in progress, non-terminal status), a skeleton beats a bare static
  // "locating…" line (audit #17's third leg). A terminal outcome (retries exhausted or the fleet status is
  // terminal) gets an explicit message instead of looping silently (audit #2).
  const workRootFallback =
    rootState === "missing" ? (
      <div className="px-3 py-3 text-[12px] text-muted">{t("rightSidebar.workdirMissing")}</div>
    ) : (
      <SkeletonRows rows={8} />
    );
  const widthState = useResizableWidth("rookery.rightWidth", 300, { min: 200, max: 560, side: "right" });
  // Width enter/exit: on mount, start at width 0 then go to the stored width after rAF → transition-[width] slides it.
  // On close, open=false makes width 0 → App's useMountTransition keeps it mounted in the meantime. (Intended layout exception since it's a docked flex child.)
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const width = open && entered ? widthState.width : 0;
  return (
    <>
      <ResizeHandle onPointerDown={widthState.startDrag} />
      <aside style={{ width }} className={cn("flex shrink-0 flex-col overflow-hidden border-l border-line bg-surface", widthState.resizing ? "" : "transition-[width] duration-[180ms] ease-out motion-reduce:transition-none")}>
        {/* Empty bar matching the main-area header height (h-11) — aligns the segment tab line to the same height as the main-area TabBar (consistent hierarchy).
            Color matches the top of the main area (<main bg-ink>) with bg-ink. */}
        <div className="drag h-11 shrink-0 border-b border-line bg-ink" />
        <Segment
          items={SEGMENTS}
          value={segment}
          onChange={setSegment}
          variant="pill"
          className="h-8 shrink-0 gap-1 border-b border-line px-2"
          itemClassName="py-1 font-medium"
        />
        {/* Replay rise-in on each segment switch (key=segment) — confirms that the visually similar dense panel actually changed. */}
        <div key={segment} className="rise-in min-h-0 flex-1 overflow-y-auto">
          {segment === "files" && (ready ? <FileTree root={root!} pageKey={pageKey} version={treeVersion} activeTabPath={activeTabPath} /> : workRootFallback)}
          {segment === "git" && (ready ? <GitChanges root={root!} pageKey={pageKey} version={treeVersion} /> : workRootFallback)}
          {segment === "worker" && (
            nestedPanels.length > 0
              ? <NestedAgents panels={nestedPanels} />
              : <div className="px-3 py-3 text-[12px] leading-relaxed text-muted">{t("rightSidebar.noNestedAgents")}</div>
          )}
        </div>
      </aside>
    </>
  );
}
