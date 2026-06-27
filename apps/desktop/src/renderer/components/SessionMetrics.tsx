import { useStore } from "../store/store.js";
import type { LogItem } from "../store/reduce.js";
import { MetricsView } from "./MetricsView.js";

// Latest stats in the session header (context %, tokens, turns, cost) — the last metrics row (agent.result).
// Subscribes to the session transcript (logsBySession) on its own so it updates without re-rendering the whole App.
const EMPTY: LogItem[] = [];

export function SessionMetrics({ sessionId }: { sessionId: string }): JSX.Element | null {
  const items = useStore((st) => st.logsBySession[sessionId] ?? EMPTY);
  return <MetricsView items={items} />;
}
