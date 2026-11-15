import type { Catalog } from "../../types.js";
export default {
  "monacoEditor.changedOnDisk": "Changed on disk (by an agent?) — reloading will discard your unsaved edits.",
  "monacoEditor.reloadFromDisk": "Reload (discard edits)",
  "monacoEditor.tooLarge": "Can't preview — this file is binary or too large.",
  "monacoEditor.openError": "Can't open this file — it failed to read.",
  "monacoEditor.saveError": "Couldn't save — your edits are not on disk",
  "monacoEditor.readOnlyOutside": "Read-only — this file is outside the work folder, so it can't be saved here.",
  "monacoEditor.saveRetry": "Retry save",
  "monacoEditor.diffLoading": "Loading changes…",
  "monacoEditor.diffError": "Couldn't load the changes.",
  "monacoEditor.diffIdentical": "No changes — both sides are identical.",
} satisfies Catalog;
