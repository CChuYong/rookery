// Cmd/Ctrl+W closes the active editor tab like an IDE instead of the whole window (audit #82). Electron's default
// menu binds it to Close Window (and on Windows/Linux closing the last window quits the app). The window itself
// moves to Shift+Cmd/Ctrl+W. On Windows/Linux the renderer hands Ctrl+W back to a focused terminal (delete-word), and
// on a page without editor tabs the renderer asks for the normal window close (lib/close-tab-dispatch.ts).
export interface ShortcutInput { type: string; key: string; code: string; meta: boolean; control: boolean; shift: boolean; alt: boolean }

export type WindowShortcut = "closeTab" | "closeWindow" | null;

export function windowShortcut(input: ShortcutInput, platform: NodeJS.Platform): WindowShortcut {
  // The physical key (code), so non-Latin layouts still work and a layout that maps "w" elsewhere isn't hijacked.
  if (input.type !== "keyDown" || input.alt || input.code !== "KeyW") return null;
  const primary = platform === "darwin" ? input.meta && !input.control : input.control && !input.meta;
  if (!primary) return null;
  return input.shift ? "closeWindow" : "closeTab";
}
