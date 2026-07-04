import type { LogItem } from "../store/reduce.js";
import { MessageList } from "../components/MessageList.js";
import { useT } from "../i18n/provider.js";

export interface NestedPanel {
  id: string; // parentToolUseId (= Task call id)
  label: string;
  items: LogItem[];
}

// Renders the nested agents a worker spawned via Task as a read-only list of panels (live only).
// The outer wrapper/resize/scroll is provided by the host (the Worker segment in RightSidebar).
export function NestedAgents({ panels }: { panels: NestedPanel[] }): JSX.Element {
  const t = useT();
  return (
    <div className="flex flex-col gap-2 p-2">
      <div className="eyebrow px-1 pt-1 eyebrow-sm font-medium uppercase text-muted">
        {t("nestedAgents.title")} · {panels.length}
      </div>
      {panels.map((p) => (
        <div key={p.id} className="rise-in flex max-h-[45vh] min-h-[120px] flex-col overflow-hidden rounded-lg border border-line bg-ink/40">
          <div className="shrink-0 truncate border-b border-line px-2.5 py-1.5 font-mono text-[11px] text-fg-dim" title={p.label}>
            🧩 {p.label}
          </div>
          <div className="flex min-h-0 flex-1 flex-col">
            <MessageList items={p.items} />
          </div>
        </div>
      ))}
    </div>
  );
}
