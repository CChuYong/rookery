import { useEffect, useRef } from "react";
import { isTypingTarget } from "./focus.js";

type KeyLike = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;

// Row/list keyboard shortcuts shared by the sidebar trees and the file tree (audit #68 #107), plus their visible labels.
// Labels follow the platform: macOS glyphs (⌘⌫, ⇧F10) vs the Windows/Linux spelled form (Delete, Shift+F10).

export function isMacPlatform(): boolean {
  return typeof window !== "undefined" && window.rookery?.platform === "darwin";
}

const primary = (e: KeyLike): boolean => (isMacPlatform() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey);

// Open the row's context menu from the keyboard: Shift+F10 or the dedicated Menu key (macOS has no Menu key).
export function isMenuKey(e: KeyLike): boolean {
  return (e.key === "F10" && e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) || e.key === "ContextMenu";
}

export function isRenameKey(e: KeyLike): boolean {
  return e.key === "F2" && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey;
}

// Delete the row: the Delete key, or Cmd+Backspace on macOS (a Mac keyboard's "delete" is Backspace) / Ctrl+Backspace.
export function isDeleteKey(e: KeyLike): boolean {
  if (e.altKey || e.shiftKey) return false;
  if (e.key === "Delete") return !e.metaKey && !e.ctrlKey;
  return e.key === "Backspace" && primary(e);
}

// Visible shortcut labels (menus, tooltips) and their aria-keyshortcuts values.
export const SHORTCUT = {
  rename: { label: () => "F2", aria: "F2" },
  delete: { label: () => (isMacPlatform() ? "⌘⌫" : "Delete"), aria: () => (isMacPlatform() ? "Meta+Backspace Delete" : "Delete Control+Backspace") },
  menu: { label: () => (isMacPlatform() ? "⇧F10" : "Shift+F10"), aria: "Shift+F10" },
} as const;

// "<label> (<shortcut>)" for a title attribute — the hint surface the rest of the chrome already uses for shortcuts.
export function withShortcut(label: string, shortcut: string): string {
  return `${label} (${shortcut})`;
}

// App-level shortcuts (audit #140) — the IDE set: Cmd/Ctrl+B sidebar, Cmd/Ctrl+N new session, Cmd/Ctrl+, settings.
// (Ctrl+` for the terminal is WorkspaceDock's.) Shown next to their controls via withShortcut / aria-keyshortcuts.
export type AppShortcut = "toggleSidebar" | "newSession" | "settings";

export function appShortcutFor(e: KeyLike, platform: string | undefined): AppShortcut | null {
  const mac = platform === "darwin";
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!mod || e.altKey || e.shiftKey) return null;
  const k = e.key.toLowerCase();
  return k === "b" ? "toggleSidebar" : k === "n" ? "newSession" : k === "," ? "settings" : null;
}

const modLabel = (key: string): string => (isMacPlatform() ? `⌘${key}` : `Ctrl+${key}`);
const modAria = (key: string): string => (isMacPlatform() ? `Meta+${key}` : `Control+${key}`);
export const APP_SHORTCUT = {
  toggleSidebar: { label: () => modLabel("B"), aria: () => modAria("B") },
  newSession: { label: () => modLabel("N"), aria: () => modAria("N") },
  settings: { label: () => modLabel(","), aria: () => modAria(",") },
  terminal: { label: () => (isMacPlatform() ? "⌃`" : "Ctrl+`"), aria: () => "Control+`" },
} as const;

// Text fields, Monaco and xterm keep their keys (Cmd+B is bold in the composer); an open modal owns the keyboard.
export function useAppShortcuts(handlers: Record<AppShortcut, () => void>): void {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || isTypingTarget(e.target) || document.querySelector('[aria-modal="true"]')) return;
      const action = appShortcutFor(e, window.rookery?.platform);
      if (!action) return;
      e.preventDefault();
      ref.current[action]();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
