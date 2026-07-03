import type { FunctionComponent, ReactNode } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { useStore } from "../store/store.js";
import { NestedAgents } from "../views/NestedAgents.js";
import type { LogItem } from "../store/reduce.js";
import type { PanelParams } from "./panel-ids.js";
import { useWorkspaceRender } from "./WorkspaceRender.js";
import { useT } from "../i18n/provider.js";

// Nested-agent label: extract subagent_type/description from the Task tool call
// input in the main transcript. (Copied from RightSidebar for the PoC; dedupe in
// Phase 3 when RightSidebar is removed.) The input JSON may be truncated, so
// match with a regex rather than JSON.parse.
function nestedLabel(mainLog: LogItem[], parentId: string): string {
  const tool = mainLog.find((i) => i.kind === "tool" && i.toolId === parentId);
  const input = tool && tool.kind === "tool" ? tool.input ?? "" : "";
  const sub = input.match(/"subagent_type"\s*:\s*"([^"]+)"/)?.[1];
  const desc = input.match(/"description"\s*:\s*"([^"]+)"/)?.[1];
  return [sub, desc].filter(Boolean).join(": ") || `worker ${parentId.slice(0, 6)}`;
}

const EMPTY_NESTED: Record<string, LogItem[]> = {};
const EMPTY_LOG: LogItem[] = [];

// Self-subscribing nested panel body: keeps the high-frequency nested/workerLogs
// reads out of App (same reasoning as the original RightSidebar Worker segment).
export function NestedPanelBody({ subId }: { subId: string | null }): JSX.Element {
  const t = useT();
  const nested = useStore((st) => (subId ? st.nested[subId] ?? EMPTY_NESTED : EMPTY_NESTED));
  const workerLog = useStore((st) => (subId ? st.workerLogs[subId] ?? EMPTY_LOG : EMPTY_LOG));
  const panels = Object.entries(nested).map(([id, items]) => ({ id, label: nestedLabel(workerLog, id), items }));
  if (panels.length === 0) return <div className="px-3 py-3 text-[12px] leading-relaxed text-muted">{t("rightSidebar.noNestedAgents")}</div>;
  return <NestedAgents panels={panels} />;
}

// dockview's panel content host has a definite height but is not a flex column,
// so components that rely on flex-1 (conversation → scrolling list + pinned
// composer, Monaco) collapse unless we give them a full-height flex context.
// Fill = flex column that pins its own footer; Scroll = plain scroll region.
const Fill = ({ children }: { children: ReactNode }): JSX.Element => <div className="flex h-full min-h-0 flex-col">{children}</div>;
const Scroll = ({ children }: { children: ReactNode }): JSX.Element => <div className="h-full min-h-0 overflow-y-auto">{children}</div>;

// dockview component map: each panel simply renders the current page's delegate.
// Editor panels read their tab id from serializable params; everything else is a
// page-level singleton whose content comes from the WorkspaceRender context.
export const dockComponents: Record<string, FunctionComponent<IDockviewPanelProps>> = {
  conversation: () => <Fill>{useWorkspaceRender().conversation()}</Fill>,
  editor: (props) => <Fill>{useWorkspaceRender().editor((props.params as PanelParams & { kind: "editor" }).tabId)}</Fill>,
  terminal: () => <Fill>{useWorkspaceRender().terminal()}</Fill>,
  files: () => <Scroll>{useWorkspaceRender().files()}</Scroll>,
  git: () => <Scroll>{useWorkspaceRender().git()}</Scroll>,
  nested: () => <Scroll>{useWorkspaceRender().nested()}</Scroll>,
};
