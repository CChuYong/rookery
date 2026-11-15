import { useEffect, type FunctionComponent, type ReactNode } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { useStore } from "../store/store.js";
import { ActivityPanel } from "../views/ActivityPanel.js";
import type { LogItem } from "../store/reduce.js";
import { nestedLabel } from "../lib/nested-label.js";
import type { PanelParams } from "./panel-ids.js";
import { useWorkspaceRender } from "./WorkspaceRender.js";
import { useT } from "../i18n/provider.js";
import { TERMINAL_COLLAPSED_HEIGHT } from "./default-template.js";
import { useTermStore } from "../store/terminals.js";

// dockview's built-in group minimum height (MINIMUM_DOCKVIEW_GROUP_PANEL_HEIGHT in dockview-core).
const DOCKVIEW_DEFAULT_MIN_HEIGHT = 100;

const EMPTY_NESTED: Record<string, LogItem[]> = {};
const EMPTY_LOG: LogItem[] = [];

// Self-subscribing nested panel body: keeps the high-frequency nested/workerLogs
// reads out of App (same reasoning as the original RightSidebar Worker segment).
export function ActivityPanelBody({ subId, loadAgentHistory }: { subId: string | null; loadAgentHistory: (workerId: string, taskId: string, agentId: string) => void }): JSX.Element {
  const t = useT();
  const nested = useStore((st) => (subId ? st.nested[subId] ?? EMPTY_NESTED : EMPTY_NESTED));
  const workerLog = useStore((st) => (subId ? st.workerLogs[subId] ?? EMPTY_LOG : EMPTY_LOG));
  const panels = Object.entries(nested).map(([id, items]) => ({ id, label: nestedLabel(workerLog, id), items }));
  if (!subId) return <div className="px-3 py-3 text-ui leading-relaxed text-muted">{t("rightSidebar.noNestedAgents")}</div>;
  return <ActivityPanel workerId={subId} nestedPanels={panels} loadAgentHistory={loadAgentHistory} />;
}

// dockview's panel content host has a definite height but is not a flex column,
// so components that rely on flex-1 (conversation → scrolling list + pinned
// composer, Monaco) collapse unless we give them a full-height flex context.
// Fill = flex column that pins its own footer; Scroll = plain scroll region.
const Fill = ({ children }: { children: ReactNode }): JSX.Element => <div className="flex h-full min-h-0 flex-col">{children}</div>;
const Scroll = ({ children }: { children: ReactNode }): JSX.Element => <div className="h-full min-h-0 overflow-y-auto">{children}</div>;

// The terminal group may collapse to its header + TerminalPanel's single "New terminal" row. Its lower minimum
// height comes from WorkspaceDock's applyDockConstraints (dock-layout.ts), which owns every group's constraints —
// setting one here too would fight it when the terminal shares a group with the conversation.
function TerminalDockPanel({ api, params }: IDockviewPanelProps): JSX.Element {
  const group = api.group;
  const pageKey = (params as PanelParams).pageKey;
  useEffect(() => {
    if (!group) return;
    // A group that was seeded collapsed got clamped up to dockview's old 100px floor before this constraint existed;
    // with no terminals open on the page, settle it back to the collapsed height (a deliberately larger size is kept).
    const openCount = useTermStore.getState().layout[pageKey]?.count ?? 0;
    if (openCount === 0 && group.api.height <= DOCKVIEW_DEFAULT_MIN_HEIGHT + 1) group.api.setSize({ height: TERMINAL_COLLAPSED_HEIGHT });
  }, [group, pageKey]);
  return <Fill>{useWorkspaceRender().terminal()}</Fill>;
}

// dockview component map: each panel simply renders the current page's delegate.
// Editor panels read their tab id from serializable params; everything else is a
// page-level singleton whose content comes from the WorkspaceRender context.
export const dockComponents: Record<string, FunctionComponent<IDockviewPanelProps>> = {
  conversation: () => <Fill>{useWorkspaceRender().conversation()}</Fill>,
  editor: (props) => <Fill>{useWorkspaceRender().editor((props.params as PanelParams & { kind: "editor" }).tabId)}</Fill>,
  terminal: TerminalDockPanel,
  files: () => <Scroll>{useWorkspaceRender().files()}</Scroll>,
  git: () => <Scroll>{useWorkspaceRender().git()}</Scroll>,
  nested: () => <Scroll>{useWorkspaceRender().nested()}</Scroll>,
};
