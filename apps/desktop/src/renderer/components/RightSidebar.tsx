import { useEffect, useState } from "react";
import { Files, GitBranch, Bot } from "lucide-react";
import { useWsStore } from "../store/workspace.js";
import { useStore } from "../store/store.js";
import { NestedAgents } from "../views/NestedAgents.js";
import { useResizableWidth } from "../lib/useResizableWidth.js";
import { ResizeHandle } from "./ResizeHandle.js";
import { cn } from "../lib/cn.js";
import type { LogItem } from "../store/reduce.js";
import { FileTree } from "./FileTree.js";
import { GitChanges } from "./GitChanges.js";
import { useTreeVersion } from "../lib/useTreeVersion.js";
import { useSegmentIndicator } from "../lib/useSegmentIndicator.js";
import { useT } from "../i18n/provider.js";

type Nested = { id: string; label: string; items: LogItem[] };

// Nested agent panel label: extracts subagent_type/description from the Task tool call input in the main transcript.
// (The input JSON may be truncated at 4000 chars, so extract robustly with a regex instead of JSON.parse.)
function nestedLabel(mainLog: LogItem[], parentId: string): string {
  const t = mainLog.find((i) => i.kind === "tool" && i.toolId === parentId);
  const input = t && t.kind === "tool" ? t.input ?? "" : "";
  const sub = input.match(/"subagent_type"\s*:\s*"([^"]+)"/)?.[1];
  const desc = input.match(/"description"\s*:\s*"([^"]+)"/)?.[1];
  return [sub, desc].filter(Boolean).join(": ") || `worker ${parentId.slice(0, 6)}`;
}

// Stable refs for the nested/workerLogs selectors (creating a fresh empty ref each time would cause infinite re-renders).
const EMPTY_NESTED: Record<string, LogItem[]> = {};
const EMPTY_LOG: LogItem[] = [];

export function RightSidebar({ open, pageKey, subId, cwd, activeTabPath }: { open: boolean; pageKey: string; subId: string | null; cwd?: string; activeTabPath: string | null }): JSX.Element {
  const t = useT();
  const SEGMENTS = [
    { key: "files" as const, icon: Files, label: t("rightSidebar.segmentFiles") },
    { key: "git" as const, icon: GitBranch, label: "Git" },
    { key: "worker" as const, icon: Bot, label: t("rightSidebar.segmentWorker") },
  ];
  const segment = useWsStore((s) => s.right.segment);
  const setSegment = useWsStore((s) => s.setSegment_);
  const seg = useSegmentIndicator(segment, []); // coral underline that slides between Files|Git|Worker
  // Computes the nested agent panels via its own subscription (moves the high-frequency nested/workerLogs reads out of App). No subId means empty panels.
  const nested = useStore((st) => (subId ? st.nested[subId] ?? EMPTY_NESTED : EMPTY_NESTED));
  const workerLog = useStore((st) => (subId ? st.workerLogs[subId] ?? EMPTY_LOG : EMPTY_LOG));
  const nestedPanels: Nested[] = Object.entries(nested).map(([id, items]) => ({ id, label: nestedLabel(workerLog, id), items }));
  const [root, setRoot] = useState<string | null>(null);
  // A worker worktree is created asynchronously (git worktree add) right after fleet.spawn. Viewing a just-created worker immediately,
  // the worktree doesn't exist yet so it falls back to ~/cwd; resolving only once would get stuck there → retry until the worktree appears (until the path ends with subId).
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let tries = 0;
    const tick = (): void => {
      void window.rookery.ws.resolveRoot({ subId: subId ?? undefined, cwd }).then((r) => {
        if (!live) return;
        setRoot(r);
        if (subId && !r.endsWith(subId) && tries < 15) { tries += 1; timer = setTimeout(tick, 300); }
      }).catch(() => { /* ignore */ });
    };
    tick();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [subId, cwd]);
  const treeVersion = useTreeVersion(root); // watch the root → increment on change (auto-refresh tree/git)
  // For a worker, only show the files/git of its ACTUAL worktree. resolveWorkRoot falls back to ~/home while `git worktree add`
  // is still running, so without this guard the user would see (and could Cmd+S-edit) their real home files as if they were the
  // worktree. Until the resolved root ends with the subId, keep the "finding work dir" placeholder. (Sessions have no subId → always ready.)
  const ready = !!root && (!subId || root.endsWith(subId));
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
        <div ref={seg.containerRef} role="tablist" className="relative flex h-8 shrink-0 items-center gap-1 border-b border-line px-2">
          {seg.rect && (
            <div
              className="pointer-events-none absolute bottom-0 h-[2px] rounded-full bg-accent transition-[left,width] duration-200 ease-out motion-reduce:transition-none"
              style={{ left: seg.rect.left, width: seg.rect.width }}
            />
          )}
          {SEGMENTS.map((s) => (
            <button
              key={s.key}
              data-seg={s.key}
              role="tab"
              aria-selected={segment === s.key}
              onClick={() => setSegment(s.key)}
              title={s.label}
              className={cn("flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors", segment === s.key ? "bg-raised text-fg" : "text-muted hover:bg-raised/60 hover:text-fg-dim")}
            >
              <s.icon size={13} /> {s.label}
            </button>
          ))}
        </div>
        {/* Replay rise-in on each segment switch (key=segment) — confirms that the visually similar dense panel actually changed. */}
        <div key={segment} className="rise-in min-h-0 flex-1 overflow-y-auto">
          {segment === "files" && (ready ? <FileTree root={root!} pageKey={pageKey} version={treeVersion} activeTabPath={activeTabPath} /> : <div className="px-3 py-3 text-[12px] text-muted">{t("rightSidebar.findingWorkDir")}</div>)}
          {segment === "git" && (ready ? <GitChanges root={root!} pageKey={pageKey} version={treeVersion} /> : <div className="px-3 py-3 text-[12px] text-muted">{t("rightSidebar.findingWorkDir")}</div>)}
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
