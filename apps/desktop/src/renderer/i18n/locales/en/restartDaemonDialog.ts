import type { Catalog } from "../../types.js";
export default {
  "restartDaemonDialog.title": "Restart daemon",
  "restartDaemonDialog.body": "Restarting the daemon interrupts any in-progress master turn and worker live streams. Persisted data — transcripts, workers, memory, settings — is kept, but in-flight turns/streams are cut off and won't resume. Continue?",
  "restartDaemonDialog.confirm": "Restart",
} satisfies Catalog;
