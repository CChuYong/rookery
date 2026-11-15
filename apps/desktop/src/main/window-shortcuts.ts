// Cmd/Ctrl+W closes the active editor tab like an IDE instead of the whole window (audit #82). Electron's default
// menu binds it to Close Window (and on Windows/Linux closing the last window quits the app). The window itself
// moves to Shift+Cmd/Ctrl+W.
export interface ShortcutInput { type: string; key: string; meta: boolean; control: boolean; shift: boolean; alt: boolean }

export type WindowShortcut = "closeTab" | "closeWindow" | null;

export function windowShortcut(input: ShortcutInput, platform: NodeJS.Platform): WindowShortcut {
  if (input.type !== "keyDown" || input.alt || input.key.toLowerCase() !== "w") return null;
  const primary = platform === "darwin" ? input.meta && !input.control : input.control && !input.meta;
  if (!primary) return null;
  return input.shift ? "closeWindow" : "closeTab";
}
