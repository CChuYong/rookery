import { MonacoEditor } from "./MonacoEditor.js";
import { MonacoDiff } from "./MonacoDiff.js";
import { CommitView } from "./CommitView.js";
import { ImagePreview } from "./ImagePreview.js";
import { isImagePath } from "../lib/isImage.js";

// Renders the content of non-agent workspace tabs (file/diff/commit) — a **single shared definition** for the worker/session views.
// (Previously this was duplicated across the two views, and one of them was missing the commit: branch, causing a bug where it rendered via the broken path.)
export function WorkspaceTab({ activeTab, pageKey, root }: { activeTab: string; pageKey: string; root: string }): JSX.Element {
  if (activeTab.startsWith("file:")) {
    const path = activeTab.slice("file:".length);
    return isImagePath(activeTab) ? <ImagePreview key={activeTab} path={path} /> : <MonacoEditor key={activeTab} pageKey={pageKey} path={path} />;
  }
  if (activeTab.startsWith("commit:")) return <CommitView key={activeTab} root={root} hash={activeTab.slice("commit:".length)} />;
  return <MonacoDiff key={activeTab} root={root} path={activeTab.slice("diff:".length)} />; // diff:<path>
}
