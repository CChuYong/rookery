import type { Catalog } from "../../types.js";
export default {
  "notice.compact": "🗜 Context compacted ({trigger}, {span} tok)",
  "notice.apiRetry": "⏳ API retry {attempt}/{max} ({error})",
  "notice.modelFallback": "↪ Model fallback: {from} → {to} ({reason})",
  "notice.memoryRecall": "🧠 Recalled {count} memories",
  "notice.notification": "🔔 {text}",
  "notice.compactFailed": "⚠ Context compaction failed{detail}",
  "notice.requiresAction": "⏸ Input/approval needed",
  "notice.interrupted": "⏹ Stopped",
  "notice.turnCap": "Turn cap reached (maxTurns={max}, num_turns={turns}) — consider stopping this session.",
  "notice.costBudget": "Cost budget reached ({spent}/{budget} USD) — consider stopping this session.",
  "notice.workerDone": "✅ Worker {label} done{provider}",
  "notice.workerFailed": "⚠️ Worker {label} failed{provider}",
  "notice.workerStopped": "⏹ Worker {label} stopped{provider}",
  "notice.codexError": "Codex error: {message}",
  "notice.codexTurnTimeout": "⏱ Codex turn stopped after {seconds}s of no response",
} satisfies Catalog;
