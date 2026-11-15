import type { Catalog } from "../../types.js";
export default {
  "automationForm.eyebrow": "자동화",
  "automationForm.sectionExecution": "모델 / 실행",
  "automationForm.provider": "백엔드",
  "automationForm.model": "모델",
  "automationForm.effort": "추론 강도",
  "automationForm.permissionMode": "권한 모드",
  "automationForm.maxTurns": "최대 턴 수",
  "automationForm.maxTurnsHint": "비우면 제한이 없어요 (워커 액션에만 적용).",
  "automationForm.costBudget": "비용 예산 (USD)",
  "automationForm.costBudgetHint": "비우면 기본값을 써요 — 워커는 설정 > 일반의 워커 비용 예산, 마스터는 제한 없음. 두 액션 모두에 적용돼요.",
  "automationForm.bypassWarning": "권한 우회 모드는 무인 실행 중 승인 없이 모든 도구를 실행해요. 신뢰하는 트리거에만 쓰세요.",
  "automationForm.codexBypassWarning": "Codex 마스터는 권한 우회 모드가 필요해요 — 이대로면 이 자동화는 실행할 때마다 실패해요.",
  "automationForm.modelDefaultOption": "기본값",
} satisfies Catalog;
