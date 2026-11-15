import type { Catalog } from "../../types.js";
export default {
  "checkpointMenu.buttonTitle": "턴 체크포인트로 되돌리기",
  "checkpointMenu.restore": "되돌리기",
  "checkpointMenu.hint": "추적 파일만 복원돼요. 이후 새로 만든 파일은 안 지워지고, 대화는 유지됩니다.",
  "checkpointMenu.empty": "체크포인트 없음",
  "checkpointMenu.turn": "턴 {turn}",
  "checkpointMenu.confirmTitle": "턴 {turn} 시점으로 되돌릴까요?",
  "checkpointMenu.confirmBody": "추적 중인 파일이 이 턴이 끝난 상태로 돌아가요. 그 뒤에 바꾼 내용은 사라지고 되돌릴 수 없어요. 대화는 그대로예요.",
  "checkpointMenu.loadFailed": "목록을 불러오지 못했어요 — 다시 시도",
} satisfies Catalog;
