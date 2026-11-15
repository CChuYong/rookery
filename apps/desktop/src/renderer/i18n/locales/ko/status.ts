import type { Catalog } from "../../types.js";
// Full-word worker/session status labels — the shared label source for StatusBadge (header) and RepoTree's
// tree tag (audit #50: previously the tree showed a bare abbreviation like 'ORPH' while the header spelled out
// 'orphaned'). See lib/status.ts::statusLabelKey.
export default {
  "status.provisioning": "준비 중",
  "status.running": "실행 중",
  "status.background": "백그라운드 작업 중",
  "status.idle": "대기 중",
  "status.stopped": "중지됨",
  "status.done": "완료",
  "status.error": "오류",
  "status.failed": "실패",
  "status.orphaned": "유실됨",
  "status.short_provisioning": "준비",
  "status.short_running": "실행",
  "status.short_background": "백그라운드",
  "status.short_idle": "대기",
  "status.short_stopped": "중지",
  "status.short_done": "완료",
  "status.short_error": "오류",
  "status.short_failed": "실패",
  "status.short_orphaned": "유실",
} satisfies Catalog;
