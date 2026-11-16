import { useEffect, useRef } from "react";
import { keyContext, modalLayerOpen, type KeyContext } from "./focus.js";

type KeyLike = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;

// Browser/IDE back-forward keys (audit #10): Cmd+[ / Cmd+] on macOS (Alt+Arrow there is word-jump in text), and
// Alt+Left / Alt+Right on Windows and Linux.
export function historyShortcutFor(e: KeyLike, platform: string | undefined): "back" | "forward" | null {
  if (e.shiftKey) return null;
  if (platform === "darwin") {
    if (!e.metaKey || e.ctrlKey || e.altKey) return null;
    return e.key === "[" ? "back" : e.key === "]" ? "forward" : null;
  }
  if (!e.altKey || e.metaKey || e.ctrlKey) return null;
  return e.key === "ArrowLeft" ? "back" : e.key === "ArrowRight" ? "forward" : null;
}

// Per-key guard (final review #3): Cmd+[ / Cmd+] work from a text field on macOS (the composer is the normal focus
// state); Monaco and xterm keep them (outdent/indent, shell keys). Alt+Arrow off macOS never fires inside any text
// entry, where it is word/line navigation.
export function historyShortcutAllowedIn(ctx: KeyContext, platform: string | undefined): boolean {
  return ctx === "none" || (ctx === "text" && platform === "darwin");
}

// Wires the history keys plus the mouse back/forward buttons (button 3/4) to the app's navigation history. An open
// modal owns both (final review #4): navigating under a ConfirmDialog would leave it floating over another page.
export function useHistoryShortcuts(goBack: () => void, goForward: () => void): void {
  const back = useRef(goBack);
  const fwd = useRef(goForward);
  back.current = goBack;
  fwd.current = goForward;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || modalLayerOpen()) return;
      const platform = window.rookery?.platform;
      const dir = historyShortcutFor(e, platform);
      if (!dir || !historyShortcutAllowedIn(keyContext(e.target), platform)) return;
      e.preventDefault();
      (dir === "back" ? back : fwd).current();
    };
    const onMouse = (e: MouseEvent): void => {
      if ((e.button !== 3 && e.button !== 4) || modalLayerOpen()) return;
      e.preventDefault();
      (e.button === 3 ? back : fwd).current();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mouseup", onMouse);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("mouseup", onMouse); };
  }, []);
}
