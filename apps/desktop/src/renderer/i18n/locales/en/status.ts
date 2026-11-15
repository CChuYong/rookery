import type { Catalog } from "../../types.js";
// Full-word worker/session status labels — the shared label source for StatusBadge (header) and RepoTree's
// tree tag (audit #50: previously the tree showed a bare abbreviation like 'ORPH' while the header spelled out
// 'orphaned'). See lib/status.ts::statusLabelKey.
export default {
  "status.provisioning": "Preparing",
  "status.running": "Running",
  "status.background": "Background tasks",
  "status.idle": "Idle",
  "status.stopped": "Stopped",
  "status.done": "Done",
  "status.error": "Error",
  "status.failed": "Failed",
  "status.orphaned": "Orphaned",
  "status.short_provisioning": "Starting",
  "status.short_running": "Running",
  "status.short_background": "Background",
  "status.short_idle": "Idle",
  "status.short_stopped": "Stopped",
  "status.short_done": "Done",
  "status.short_error": "Error",
  "status.short_failed": "Failed",
  "status.short_orphaned": "Orphaned",
} satisfies Catalog;
