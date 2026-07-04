import type { Catalog } from "../../types.js";
// Full-word worker/session status labels — the shared label source for StatusBadge (header) and RepoTree's
// tree tag (audit #50: previously the tree showed a bare abbreviation like 'ORPH' while the header spelled out
// 'orphaned'). See lib/status.ts::statusLabelKey.
export default {
  "status.provisioning": "Preparing",
  "status.running": "Running",
  "status.idle": "Idle",
  "status.stopped": "Stopped",
  "status.done": "Done",
  "status.error": "Error",
  "status.failed": "Failed",
  "status.orphaned": "Orphaned",
} satisfies Catalog;
