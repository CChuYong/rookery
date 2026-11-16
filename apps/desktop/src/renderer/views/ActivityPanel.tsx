import { useStore } from "../store/store.js";
import { useT } from "../i18n/provider.js";
import { NestedAgents, type NestedPanel } from "./NestedAgents.js";
import { WorkflowRuns } from "./WorkflowRuns.js";
import { isTerminalStatus } from "../lib/status.js";

const EMPTY_RUNS = {};

export function ActivityPanel({
  workerId,
  nestedPanels,
  loadAgentHistory,
}: {
  workerId: string;
  nestedPanels: NestedPanel[];
  loadAgentHistory(workerId: string, taskId: string, agentId: string): void;
}): JSX.Element {
  const t = useT();
  const workflows = useStore((state) => state.workflows[workerId] ?? EMPTY_RUNS);
  const status = useStore((state) => state.fleet[workerId]?.status);
  const empty = Object.keys(workflows).length === 0 && nestedPanels.length === 0;
  // Sub-agent activity is live-only: an ended worker gets "nothing recorded" rather than a promise of activity "yet"
  // (audit #115). Idle or unknown (row not loaded yet) still reads as "not yet".
  const ended = status !== undefined && isTerminalStatus(status);
  if (empty) return <div className="px-3 py-2 text-ui text-faint">{t(ended ? "workflowActivity.emptyEnded" : "workflowActivity.empty")}</div>;
  return (
    <div className="flex flex-col">
      <WorkflowRuns workerId={workerId} loadAgentHistory={loadAgentHistory} />
      {nestedPanels.length > 0 && (
        <div className="border-t border-line">
          <NestedAgents panels={nestedPanels} title={t("workflowActivity.nestedAgents")} />
        </div>
      )}
    </div>
  );
}
