import type { Catalog } from "../../types.js";
export default {
  "attentionBell.title": "지금 필요한 것",
  "attentionBell.aria": "어텐션 큐 ({count}건)",
  "attentionBell.empty": "지금 필요한 것이 없어요. 전부 순항 중 ✨",
  "attentionBell.tier0": "응답 대기",
  "attentionBell.tier1": "실패",
  "attentionBell.tier2": "리뷰 대기",
  "attentionBell.kind_interaction": "질문/승인이 답을 기다려요",
  "attentionBell.kind_worker-failure": "워커 실패",
  "attentionBell.kind_automation-failure": "자동화 실패",
  "attentionBell.kind_worker-review": "워커가 끝났어요 — 확인 필요",
  "attentionBell.kind_session-review": "안 읽은 응답",
  "attentionBell.dismiss": "묵살",
  "attentionBell.notifyTitle": "응답 대기 중",
  "attentionBell.notifyBody": "{label} 세션이 당신의 답을 기다리고 있어요.",
} satisfies Catalog;
