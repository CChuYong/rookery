import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import { langOf } from "../lib/monacoLang.js";

// If commit is provided, show that commit's parent↔commit contents; otherwise show HEAD↔working copy.
export function MonacoDiff({ root, path, commit }: { root: string; path: string; commit?: string }): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !root) return; // when wsRoot is still "", avoid a useless gitDiff("",...) call — the effect re-runs after root resolves
    let disposed = false;
    const ed = monaco.editor.createDiffEditor(host, {
      theme: "rookery-ink",
      readOnly: true,
      automaticLayout: true,
      renderSideBySide: true,
      fontFamily: "'Geist Mono Variable', ui-monospace, monospace",
      fontSize: 12.5,
      minimap: { enabled: false },
    });
    const rel = path.startsWith(root + "/") ? path.slice(root.length + 1) : path;
    const load = commit
      ? window.rookery.ws.gitShowFileDiff(root, commit, rel).then(({ before, after }) => ({ head: before, work: after }))
      : window.rookery.ws.gitDiff(root, rel);
    void load.then(({ head, work }) => {
      if (disposed) return;
      ed.setModel({
        original: monaco.editor.createModel(head, langOf(path)),
        modified: monaco.editor.createModel(work, langOf(path)),
      });
    });
    return () => {
      disposed = true;
      const m = ed.getModel();
      m?.original.dispose();
      m?.modified.dispose();
      ed.dispose();
    };
  }, [root, path, commit]);
  return <div ref={hostRef} className="min-h-0 flex-1" />;
}
