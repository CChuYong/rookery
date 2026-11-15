import { useEffect, useState } from "react";
import { Minus, Square, Copy, X } from "lucide-react";
import { useT } from "../i18n/provider.js";

// Custom window controls for the frameless Windows/Linux builds (frame: false).
// macOS keeps its native traffic lights (titleBarStyle: hiddenInset), so this renders nothing there.
export function WindowControls() {
  const t = useT();
  const isMac = (window.rookery?.platform ?? "darwin") === "darwin"; // no bridge (tests) → treat as mac → render nothing
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    // Flag the document so headers reserve top-right space for these controls (CSS .win-chrome .wco-pad). No-op on macOS.
    document.documentElement.classList.toggle("win-chrome", !isMac);
    if (isMac) return;
    void window.rookery.win.isMaximized().then(setMaximized);
    return window.rookery.win.onMaximizeChange(setMaximized);
  }, [isMac]);

  if (isMac) return null;

  // Dedicated title bar strip (Windows/Linux). The strip is the drag (window-move) region; the buttons are
  // no-drag CHILDREN of it — the only reliable way to keep them clickable (z-index alone loses to an
  // overlapping drag region's OS hit-test). App content is pushed below it via .win-chrome .app-top-inset.
  const btn = "no-drag flex h-8 w-12 items-center justify-center text-muted transition-colors";
  return (
    <div className="drag fixed inset-x-0 top-0 z-[100] flex h-8 items-center bg-ink">
      <span className="select-none pl-3 text-meta font-medium tracking-[-0.01em] text-muted/70">Rookery</span>
      <div className="ml-auto flex h-full items-center">
        <button className={`${btn} hover:bg-raised hover:text-fg-dim`} aria-label={t("windowControls.minimize")} onClick={() => window.rookery.win.minimize()}>
          <Minus size={14} />
        </button>
        <button className={`${btn} hover:bg-raised hover:text-fg-dim`} aria-label={maximized ? t("windowControls.restore") : t("windowControls.maximize")} onClick={() => window.rookery.win.maximize()}>
          {maximized ? <Copy size={12} /> : <Square size={12} />}
        </button>
        <button className={`${btn} hover:bg-fail hover:text-white`} aria-label={t("common.close")} onClick={() => window.rookery.win.close()}>
          <X size={16} />
        </button>
      </div>
    </div>
  );
}
