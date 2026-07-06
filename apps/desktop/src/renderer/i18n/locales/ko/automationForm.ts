import type { Catalog } from "../../types.js";
export default {
  "automationForm.eyebrow": "자동화",
  "automationForm.sectionExecution": "모델 / 실행",
  "automationForm.provider": "에이전트 백엔드",
  "automationForm.model": "모델",
  "automationForm.effort": "effort",
  "automationForm.permissionMode": "권한 모드",
  "automationForm.maxTurns": "최대 턴 수",
  "automationForm.maxTurnsHint": "비우면 제한 없음 (워커 액션에만 적용).",
  "automationForm.costBudget": "비용 예산 (USD)",
  "automationForm.costBudgetHint": "비우면 기본값 사용 (워커는 workerCostBudgetUsd 설정값, 마스터는 무제한). 두 액션 모두 적용.",
  "automationForm.bypassWarning": "bypassPermissions는 무인 실행 시 승인 없이 모든 도구를 실행합니다. 신뢰된 트리거에만 사용하세요.",
  "automationForm.codexBypassWarning": "Codex 세션은 bypassPermissions가 필요합니다 — 이 자동화는 실행할 때마다 실패합니다.",
  "automationForm.modelDefaultOption": "기본값",
} satisfies Catalog;
