import { describe, expect, it, vi } from "vitest";

// Lexical reads navigator.platform once at module load to pick Cmd vs Ctrl for its own key bindings, so the Apple
// platform has to be in place before the editor modules are imported (this file's module graph is isolated).
vi.hoisted(() => {
  Object.defineProperty(window.navigator, "platform", { value: "MacIntel", configurable: true });
});

import { fireEvent, render, waitFor } from "@testing-library/react";
import { getEditorPropertyFromDOMNode, isLexicalEditor } from "lexical";
import { PromptEditor } from "../src/renderer/components/PromptEditor.js";

// Final review #3: Cmd+B is the advertised sidebar shortcut. On macOS the composer hands it to the app instead of
// applying a bold that the plain-text prompt never carries.
describe("PromptEditor on macOS (final review #3)", () => {
  it("does not consume Cmd+B, so the window-level shortcut sees it", async () => {
    (window as unknown as { rookery: unknown }).rookery = { platform: "darwin" };
    try {
      const { getByRole } = render(<PromptEditor initialText="hello" />);
      const root = getByRole("textbox");
      await waitFor(() => expect(isLexicalEditor(getEditorPropertyFromDOMNode(root))).toBe(true));
      const seen: boolean[] = [];
      const onWindow = (e: KeyboardEvent): void => { seen.push(e.defaultPrevented); };
      window.addEventListener("keydown", onWindow);
      fireEvent.keyDown(root, { key: "b", metaKey: true });
      window.removeEventListener("keydown", onWindow);
      expect(seen).toEqual([false]);
    } finally {
      delete (window as unknown as { rookery?: unknown }).rookery;
    }
  });

  it("keeps Lexical's other Cmd bindings (Cmd+I italic is still consumed)", async () => {
    (window as unknown as { rookery: unknown }).rookery = { platform: "darwin" };
    try {
      const { getByRole } = render(<PromptEditor initialText="hello" />);
      const root = getByRole("textbox");
      await waitFor(() => expect(isLexicalEditor(getEditorPropertyFromDOMNode(root))).toBe(true));
      const seen: boolean[] = [];
      const onWindow = (e: KeyboardEvent): void => { seen.push(e.defaultPrevented); };
      window.addEventListener("keydown", onWindow);
      fireEvent.keyDown(root, { key: "i", metaKey: true });
      window.removeEventListener("keydown", onWindow);
      expect(seen).toEqual([true]);
    } finally {
      delete (window as unknown as { rookery?: unknown }).rookery;
    }
  });
});
