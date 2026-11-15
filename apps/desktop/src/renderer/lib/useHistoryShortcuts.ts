import { useEffect, useRef } from "react";

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

// Typing targets keep their keys (Monaco/xterm both type into a textarea; Cmd+[ is outdent in the editor).
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  return !!el.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], .monaco-editor");
}

// Wires the history keys plus the mouse back/forward buttons (button 3/4) to the app's navigation history.
export function useHistoryShortcuts(goBack: () => void, goForward: () => void): void {
  const back = useRef(goBack);
  const fwd = useRef(goForward);
  back.current = goBack;
  fwd.current = goForward;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || isTypingTarget(e.target)) return;
      const dir = historyShortcutFor(e, window.rookery?.platform);
      if (!dir) return;
      e.preventDefault();
      (dir === "back" ? back : fwd).current();
    };
    const onMouse = (e: MouseEvent): void => {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault();
      (e.button === 3 ? back : fwd).current();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mouseup", onMouse);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("mouseup", onMouse); };
  }, []);
}
