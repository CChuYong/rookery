import type { Catalog } from "../../types.js";
export default {
  "branchDiff.empty": "No changes since the base",
  "branchDiff.loadFailed": "Couldn't load the branch changes",
  "branchDiff.files": "{count} changed files",
  "branchDiff.vsForkPoint": "Changes since the branch forked",
  "branchDiff.truncated": "The diff is too large — showing the first 512 KB",
  "branchDiff.binary": "Binary file — no text diff to show",
  "branchDiff.renamedOnly": "Renamed only: {from} → {to}",
  "branchDiff.modeOnly": "File mode changed only ({mode})",
  "branchDiff.noTextChange": "No content changes",
} satisfies Catalog;
