import type { Catalog } from "../../types.js";
export default {
  "checkpointMenu.buttonTitle": "턴 체크포인트로 복원",
  "checkpointMenu.restore": "복원",
  "checkpointMenu.hint": "추적 중인 파일만 복원돼요. 이후 새로 만든 파일은 지워지지 않고, 대화는 그대로예요.",
  "checkpointMenu.empty": "체크포인트 없음",
  "checkpointMenu.turn": "턴 {turn}",
  "checkpointMenu.confirmTitle": "턴 {turn} 시작 전으로 파일을 복원할까요?",
  "checkpointMenu.confirmBody": "추적 중인 파일을 이 턴이 시작되기 전 상태로 복원해요. 이 턴의 변경 사항과 그 뒤의 변경 사항은 모두 사라지고 되돌릴 수 없어요. 대화는 그대로예요.",
  "checkpointMenu.loadFailed": "목록을 불러오지 못했어요 — 다시 시도",
} satisfies Catalog;
