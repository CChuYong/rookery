import { useEffect, useState } from "react";
import { Minus, Square, Copy, X } from "lucide-react";

// Custom window controls for the frameless Windows/Linux builds (frame: false).
// macOS keeps its native traffic lights (titleBarStyle: hiddenInset), so this renders nothing there.
export function WindowControls() {
  const isMac = window.rookery.platform === "darwin";
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (isMac) return;
    void window.rookery.win.isMaximized().then(setMaximized);
    return window.rookery.win.onMaximizeChange(setMaximized);
  }, [isMac]);

  if (isMac) return null;

  const btn = "no-drag flex h-10 w-12 items-center justify-center text-muted transition-colors";
  return (
    <div className="no-drag fixed right-0 top-0 z-50 flex h-10 items-center">
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
