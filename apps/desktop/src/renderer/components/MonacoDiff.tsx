import { useEffect, useRef, useState } from "react";
import * as monaco from "monaco-editor";
import { langOf } from "../lib/monacoLang.js";
import { useT } from "../i18n/provider.js";

type DiffState = "loading" | "ready" | "identical" | "error";

// If commit is provided, show that commit's parent↔commit contents; otherwise show HEAD↔working copy.
// Loading, failure and "no changes" each get their own note over the editor (audit #18) — before, all three looked
// like a blank grey pane or two identical columns.
export function MonacoDiff({ root, path, commit }: { root: string; path: string; commit?: string }): JSX.Element {
  const t = useT();
  const hostRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<DiffState>("loading");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !root) return; // when wsRoot is still "", avoid a useless gitDiff("",...) call — the effect re-runs after root resolves
    let disposed = false;
    setState("loading");
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
      setState(head === work ? "identical" : "ready");
    }).catch(() => { if (!disposed) setState("error"); });
    return () => {
      disposed = true;
      const m = ed.getModel();
      m?.original.dispose();
      m?.modified.dispose();
      ed.dispose();
    };
  }, [root, path, commit, attempt]);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {state !== "ready" && (
        <div role="status" className="flex shrink-0 items-center gap-2 border-b border-line bg-raised px-3 py-1.5 text-ui text-muted">
          <span>
            {state === "loading" ? t("monacoEditor.diffLoading") : state === "error" ? t("monacoEditor.diffError") : t("monacoEditor.diffIdentical")}
          </span>
          {state === "error" && (
            <button onClick={() => setAttempt((n) => n + 1)} className="rounded border border-line px-2 py-0.5 text-fg-dim transition-colors hover:bg-ink/40 hover:text-fg">
              {t("common.retry")}
            </button>
          )}
        </div>
      )}
      <div ref={hostRef} className="min-h-0 flex-1" />
    </div>
  );
}
