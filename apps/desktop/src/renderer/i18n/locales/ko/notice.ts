import type { Catalog } from "../../types.js";
export default {
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
  "notice.codexError": "Codex 오류: {message}",
  "notice.codexTurnTimeout": "⏱ Codex 턴이 {seconds}초 동안 응답이 없어 중단됨",
} satisfies Catalog;
