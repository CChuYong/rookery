// Self-contained daemon-side i18n (ko/en) for Slack/CLI/core-notice strings — independent of the desktop renderer catalog.
// Korean is the default. Keys are grouped by surface: notice.* slack.* cli.* interaction.*
export type Locale = "ko" | "en";
type Params = Record<string, string | number>;

export const KO = {
  // notice.* — master/system informational pushes (also mirrored in the desktop renderer notice.* catalog; keep keys + param names in sync)
  "notice.compact": "🗜 컨텍스트 압축됨 ({trigger}, {span} tok)",
  "notice.apiRetry": "⏳ API 재시도 {attempt}/{max} ({error})",
  "notice.modelFallback": "↪ 모델 폴백: {from} → {to} ({reason})",
  "notice.memoryRecall": "🧠 기억 {count}개 참조",
  "notice.notification": "🔔 {text}",
  "notice.compactFailed": "⚠ 컨텍스트 압축 실패{detail}",
  "notice.requiresAction": "⏸ 입력/승인 필요",
  "notice.interrupted": "⏹ 중단됨",
  "notice.turnCap": "턴 한도 도달 (maxTurns={max}, num_turns={turns}) — 세션 중단을 고려하세요.",
  "notice.workerDone": "✅ 워커 {label} 완료",
  "notice.workerFailed": "⚠️ 워커 {label} 실패",
  "notice.workerStopped": "⏹ 워커 {label} 종료",
  // interaction.* — approval/answer summaries + SDK deny reasons
  "interaction.approved": "✅ 승인됨",
  "interaction.rejected": "🚫 거부됨",
  "interaction.denied": "사용자가 거부했어요.",
  "interaction.answered": "✅ 답변 완료\n{summary}",
  "interaction.cancelled": "취소됨",
  "interaction.postFailed": "Slack에 질문 카드를 게시하지 못했어요 — 사용자에게 물어볼 수 없습니다.",
  "interaction.expired": "만료됨 — 이 요청은 더 이상 대기 중이 아니에요.",
  // slack.* — Slack adapter UI strings
  "slack.greeting": "안녕하세요! rookery입니다. 무엇을 도와드릴까요?",
  "slack.askQuestion": "❓ 에이전트의 질문에 답해주세요",
  "slack.approveNeeded": "🔐 승인 필요: {tool}",
  "slack.approvePrompt": "🔐 *{tool}* 를 실행할까요?{detail}",
  "slack.approveBtn": "승인",
  "slack.denyBtn": "거부",
  "slack.noFile": "첨부 파일을 받지 못했어요(봇에 files:read 스코프가 필요할 수 있어요).",
  "slack.emptyMsg": "메시지를 함께 적어주세요 🙂",
  "slack.partialFile": "첨부 파일 {count}개를 읽지 못해 텍스트만으로 답할게요(봇에 files:read 스코프가 필요할 수 있어요).",
  "slack.redactedMarker": "🗑️ _[삭제됨]_",
  "slack.thinking": "💭 추론",
  "slack.worker": "🔧 워커 {label}",
  "slack.workerRepo": "레포 {repo}",
  // cli.* — CLI client-local notices
  "cli.noResponse": "데몬에서 응답이 없어요 — 처리 중이거나 멈췄을 수 있어요.",
  "cli.sessionNotReady": "세션이 아직 준비되지 않았어요. 잠시 후 다시 시도하세요.",
  "cli.connected": "연결됨. 메시지를 입력하세요 (Ctrl-D 로 종료).",
  "cli.connClosed": "데몬이 연결을 닫았어요.",
  "cli.connError": "연결 오류.",
} as const;

export const EN: Record<keyof typeof KO, string> = {
  "notice.compact": "🗜 Context compacted ({trigger}, {span} tok)",
  "notice.apiRetry": "⏳ API retry {attempt}/{max} ({error})",
  "notice.modelFallback": "↪ Model fallback: {from} → {to} ({reason})",
  "notice.memoryRecall": "🧠 Recalled {count} memories",
  "notice.notification": "🔔 {text}",
  "notice.compactFailed": "⚠ Context compaction failed{detail}",
  "notice.requiresAction": "⏸ Input/approval needed",
  "notice.interrupted": "⏹ Stopped",
  "notice.turnCap": "Turn cap reached (maxTurns={max}, num_turns={turns}) — consider stopping this session.",
  "notice.workerDone": "✅ Worker {label} done",
  "notice.workerFailed": "⚠️ Worker {label} failed",
  "notice.workerStopped": "⏹ Worker {label} stopped",
  "interaction.approved": "✅ Approved",
  "interaction.rejected": "🚫 Denied",
  "interaction.denied": "The user denied it.",
  "interaction.answered": "✅ Answered\n{summary}",
  "interaction.cancelled": "Cancelled",
  "interaction.postFailed": "Failed to post the question card to Slack — the user could not be asked.",
  "interaction.expired": "Expired — this request is no longer pending.",
  "slack.greeting": "Hi! I'm rookery. How can I help?",
  "slack.askQuestion": "❓ Please answer the agent's question",
  "slack.approveNeeded": "🔐 Approval needed: {tool}",
  "slack.approvePrompt": "🔐 Run *{tool}*?{detail}",
  "slack.approveBtn": "Approve",
  "slack.denyBtn": "Deny",
  "slack.noFile": "Couldn't receive the attachment (the bot may need the files:read scope).",
  "slack.emptyMsg": "Please include a message 🙂",
  "slack.partialFile": "Couldn't read {count} attachment(s) — answering from text only (the bot may need the files:read scope).",
  "slack.redactedMarker": "🗑️ _[redacted]_",
  "slack.thinking": "💭 Reasoning",
  "slack.worker": "🔧 Worker {label}",
  "slack.workerRepo": "Repo {repo}",
  "cli.noResponse": "No response from the daemon — it may be working or stuck.",
  "cli.sessionNotReady": "Session not ready yet, try again.",
  "cli.connected": "connected. type a message (Ctrl-D to quit).",
  "cli.connClosed": "connection closed by daemon.",
  "cli.connError": "connection error.",
};

const CATALOGS: Record<Locale, Record<keyof typeof KO, string>> = { ko: KO, en: EN };

export const DEFAULT_LOCALE: Locale = "ko";

export function resolveLocale(s?: string | null): Locale {
  return (s ?? "").toLowerCase().startsWith("ko") ? "ko" : (s ? "en" : "ko");
}

export function t(locale: Locale, key: keyof typeof KO, params?: Params): string {
  const template = CATALOGS[locale][key];
  return template.replace(/\{(\w+)\}/g, (_m, k: string) => (params && k in params ? String(params[k]) : `{${k}}`));
}
