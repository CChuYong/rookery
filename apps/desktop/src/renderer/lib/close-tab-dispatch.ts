import { useEffect } from "react";
import { modalLayerOpen } from "./focus.js";

// Cmd/Ctrl+W routing (audit #82, final review #2). main always intercepts the key (the default menu would otherwise
// close the window, and on Windows/Linux a focused shell needs it as delete-word), forwards it here, and relies on
// this module to either handle it or ask for the normal window close. So ⌘W on a page without editor tabs (Settings,
// Automation, New session, the spawn page) still closes the window as the macOS menu promises.
//
// Order: an open modal layer swallows the key (never close a tab or the window under a dialog); on Windows/Linux a
// focused terminal receives Ctrl+W (0x17) as the shell's delete-word; then the workspace page handlers registered
// by useCloseTabShortcut; nothing handled → close the window.

export type CloseTabHandler = () => boolean;

const handlers = new Set<CloseTabHandler>();

/** Registers a page-level handler. It returns true when it took the key (even as a deliberate no-op). */
export function onCloseTabShortcut(handler: CloseTabHandler): () => void {
  handlers.add(handler);
  return () => { handlers.delete(handler); };
}

/** Runs the routing above. Returns false when nothing took the key (the caller then closes the window). */
export function dispatchCloseTab(): boolean {
  if (modalLayerOpen()) return true;
  if (window.rookery?.platform !== "darwin") {
    const termId = (document.activeElement?.closest("[data-term-id]") as HTMLElement | null)?.dataset.termId;
    if (termId) { window.rookery.term.write(termId, "\x17"); return true; }
  }
  let handled = false;
  for (const h of [...handlers]) if (h()) handled = true;
  return handled;
}

/** Mounted once by App: listens for the forwarded key and falls back to closing the window when unhandled. */
export function useCloseTabDispatch(): void {
  useEffect(() => {
    const off = window.rookery?.win?.onCloseTab?.(() => {
      if (!dispatchCloseTab()) window.rookery.win.close();
    });
    return () => off?.();
  }, []);
}
