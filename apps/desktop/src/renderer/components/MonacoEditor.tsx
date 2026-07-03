import { useEffect, useRef, useState } from "react";
import * as monaco from "monaco-editor";
import { useWsStore } from "../store/workspace.js";
import { langOf } from "../lib/monacoLang.js";
import { decideDiskChange } from "../lib/disk-change.js";
import { Collapse } from "./Collapse.js";
import { useT } from "../i18n/provider.js";

export function MonacoEditor({ pageKey, path }: { pageKey: string; path: string }): JSX.Element {
  const t = useT();
  const hostRef = useRef<HTMLDivElement>(null);
  const edRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  // We need savedValue and reload to share their latest values even outside the effect (the banner button), so we keep them in a ref.
  // (With a closure-local let, even after reload updates it, the dirty comparison inside the effect would still see the old baseline and immediately go dirty.)
  const savedRef = useRef("");
  // The content we last wrote to disk — recorded synchronously on Cmd+S so we can identify the watcher echo as a self-write (prevents false-positive banner).
  const lastWrittenRef = useRef<string | null>(null);
  const setDirty = useWsStore((s) => s.setDirty_);
  const [banner, setBanner] = useState<null | "changed" | "deleted" | "toolarge" | "error" | "saveError">(null);
  // The save command, re-bound to the latest closure on every effect run — the saveError banner's retry button
  // reaches through this ref since the button lives outside the effect that creates the editor instance.
  const saveRef = useRef<() => void>(() => {});

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    const ed = monaco.editor.create(host, {
      value: "", language: langOf(path), theme: "rookery-ink", automaticLayout: true,
      fontFamily: "'Geist Mono Variable', ui-monospace, monospace", fontSize: 12.5, minimap: { enabled: false }, scrollBeyondLastLine: false,
    });
    edRef.current = ed;
    const id = `file:${path}`;

    const load = async (): Promise<void> => {
      let r: { content: string; tooLarge: boolean };
      try { r = await window.rookery.ws.read(path); }
      catch { if (!disposed) setBanner("error"); return; } // outside the work folder / read failure → banner (so the reject doesn't leak as unhandled)
      if (disposed) return;
      if (r.tooLarge) { setBanner("toolarge"); return; }
      savedRef.current = r.content;
      ed.setValue(r.content);
      setDirty(pageKey, id, false);
      setBanner(null);
    };
    void load();

    ed.onDidChangeModelContent(() => setDirty(pageKey, id, ed.getValue() !== savedRef.current));
    const save = (): void => {
      const value = ed.getValue();
      lastWrittenRef.current = value; // synchronous record — even if the watcher echo arrives before the write's .then, it's recognized as a self-write
      void window.rookery.ws.write(path, value).then((res) => {
        // A write failure gets its own saveError banner (distinct from the read-failure openError) so the user isn't
        // misled into thinking a failed save actually landed on disk. A later successful save clears it.
        if (res.ok) { savedRef.current = value; setDirty(pageKey, id, false); setBanner((b) => (b === "saveError" ? null : b)); }
        else setBanner("saveError");
      }).catch(() => setBanner("saveError"));
    };
    saveRef.current = save;
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, save);

    window.rookery.ws.watch(path);
    const off = window.rookery.ws.onChanged((p) => {
      if (p !== path) return;
      // Read from disk to filter out self-write echoes / spurious events (the issue where a Cmd+S self-save was falsely flagged as "Changed on disk").
      void window.rookery.ws.read(path).then((r) => {
        if (disposed || r.tooLarge) return;
        const action = decideDiskChange({ disk: r.content, lastWritten: lastWrittenRef.current, buffer: ed.getValue(), saved: savedRef.current });
        if (action === "ignore") return;
        if (action === "adopt") {
          savedRef.current = r.content; // update the baseline first → setValue won't flip to dirty
          ed.setValue(r.content);
          setDirty(pageKey, id, false);
          setBanner(null);
        } else {
          setBanner("changed"); // buffer dirty + external change → banner
        }
      }).catch(() => { /* read failure: ignore (recovers on the next event / manual reload) */ });
    });

    return () => { disposed = true; off(); window.rookery.ws.unwatch(path); edRef.current = null; ed.dispose(); };
  }, [pageKey, path, setDirty]);

  const reload = (): void => {
    void window.rookery.ws.read(path).then((r) => {
      if (r.tooLarge || !edRef.current) return; // after disposal edRef.current=null, so don't setValue
      edRef.current.setValue(r.content);
      savedRef.current = r.content; // update the baseline → won't flip to dirty right after reload
      setDirty(pageKey, `file:${path}`, false);
      setBanner(null);
    }).catch(() => { /* read failure — keep the existing banner */ });
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* external-change / error banner — reveals via slide-down (Monaco's automaticLayout tracks the reduced height). */}
      <Collapse open={banner !== null}>
        {banner === "changed" ? (
          <div className="flex items-center justify-between gap-2 border-b border-run/30 bg-run/12 px-3 py-1.5 text-[12px] text-run">
            <span>{t("monacoEditor.changedOnDisk")}</span>
            <button onClick={reload} className="rounded border border-run/40 px-2 py-0.5 transition-colors hover:bg-run/15 active:scale-[0.97] motion-reduce:active:scale-100">{t("monacoEditor.reloadFromDisk")}</button>
          </div>
        ) : banner === "toolarge" ? (
          <div className="border-b border-line bg-raised px-3 py-1.5 text-[12px] text-muted">{t("monacoEditor.tooLarge")}</div>
        ) : banner === "saveError" ? (
          <div className="flex items-center justify-between gap-2 border-b border-fail/30 bg-fail/12 px-3 py-1.5 text-[12px] text-fail">
            <span>{t("monacoEditor.saveError")}</span>
            <button onClick={() => saveRef.current()} className="rounded border border-fail/40 px-2 py-0.5 transition-colors hover:bg-fail/15 active:scale-[0.97] motion-reduce:active:scale-100">{t("monacoEditor.saveRetry")}</button>
          </div>
        ) : banner === "error" ? (
          <div className="border-b border-line bg-raised px-3 py-1.5 text-[12px] text-muted">{t("monacoEditor.openError")}</div>
        ) : null}
      </Collapse>
      <div ref={hostRef} className="min-h-0 flex-1" />
    </div>
  );
}
