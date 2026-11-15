import type { Catalog } from "../../types.js";
export default {
  "checkpointMenu.buttonTitle": "Restore a turn checkpoint",
  "checkpointMenu.restore": "Restore",
  "checkpointMenu.hint": "Only tracked files are restored. Files created afterward stay, and the conversation is kept.",
  "checkpointMenu.empty": "No checkpoints",
  "checkpointMenu.turn": "Turn {turn}",
  "checkpointMenu.confirmTitle": "Restore files to before turn {turn}?",
  "checkpointMenu.confirmBody": "Tracked files are restored to how they were before this turn started. This turn's changes and everything after it are lost and can't be recovered. The conversation is kept.",
  "checkpointMenu.loadFailed": "Couldn't load checkpoints — retry",
} satisfies Catalog;
