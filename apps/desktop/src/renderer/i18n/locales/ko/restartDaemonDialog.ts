import type { Catalog } from "../../types.js";
export default {
  "restartDaemonDialog.title": "데몬 재시작",
  "restartDaemonDialog.body": "진행 중인 마스터 턴과 워커 라이브 스트림이 중단돼요. 대화 전사·워커·메모리·설정 등 영속 데이터는 보존되지만, 진행 중이던 턴/스트림은 끊기고 복원되지 않아요. 계속할까요?",
  "restartDaemonDialog.confirm": "재시작",
} satisfies Catalog;
