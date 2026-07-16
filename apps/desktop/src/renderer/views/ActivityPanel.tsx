import { useStore } from "../store/store.js";
import { useT } from "../i18n/provider.js";
import { NestedAgents, type NestedPanel } from "./NestedAgents.js";
import { WorkflowRuns } from "./WorkflowRuns.js";

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
  const empty = Object.keys(workflows).length === 0 && nestedPanels.length === 0;
  if (empty) return <div className="px-3 py-3 text-[12px] leading-relaxed text-muted">{t("workflowActivity.empty")}</div>;
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
