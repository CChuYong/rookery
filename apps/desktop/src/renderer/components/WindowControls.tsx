import { useEffect, useState } from "react";
import { Minus, Square, Copy, X } from "lucide-react";

// Custom window controls for the frameless Windows/Linux builds (frame: false).
// macOS keeps its native traffic lights (titleBarStyle: hiddenInset), so this renders nothing there.
export function WindowControls() {
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

  const btn = "no-drag flex h-11 w-12 items-center justify-center text-muted transition-colors";
  return (
    <div className="no-drag fixed right-0 top-0 z-[100] flex h-11 items-center">
      <button className={`${btn} hover:bg-raised hover:text-fg-dim`} aria-label="Minimize" onClick={() => window.rookery.win.minimize()}>
        <Minus size={15} />
      </button>
      <button className={`${btn} hover:bg-raised hover:text-fg-dim`} aria-label={maximized ? "Restore" : "Maximize"} onClick={() => window.rookery.win.maximize()}>
        {maximized ? <Copy size={12} /> : <Square size={12} />}
      </button>
      <button className={`${btn} hover:bg-red-600 hover:text-white`} aria-label="Close" onClick={() => window.rookery.win.close()}>
        <X size={16} />
      </button>
    </div>
  );
}
