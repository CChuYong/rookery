# Prompt Paste Undo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make plain-text paste in the desktop prompt editor a native Chromium undoable edit without breaking inline file chips, markdown rendering, or fallback behavior.

**Architecture:** Keep the rich `contentEditable="true"` host because it owns non-editable file chips and visual markdown nodes. Replace the paste path's raw Range-only mutation with Chromium's undo-buffer-preserving `insertText` editing command, retain the Range insertion as a defensive fallback, and suppress paste-triggered markdown shortcuts so paste keeps its current visual semantics.

**Tech Stack:** React 18, TypeScript, Electron 32.3.3 / Chromium 128, Vitest, Testing Library, jsdom

## Global Constraints

- Activate Node 22 before every repository command.
- Preserve plain-text-only paste; clipboard HTML must never enter the editor.
- Preserve the current `contentEditable="true"` rich DOM used by file chips and markdown elements.
- Do not add dependencies or change daemon/protocol/persistence code.
- Keep a fallback for environments where `document.execCommand("insertText")` is unavailable, returns false, or throws.
- Do not commit unless the user explicitly requests a commit.

---

### Task 1: Undoable plain-text paste

**Files:**
- Modify: `apps/desktop/src/renderer/components/PromptEditor.tsx:44-176`
- Test: `apps/desktop/test/prompt-editor.test.tsx`

**Interfaces:**
- Consumes: the existing `insertNodesAtCaret(root: HTMLElement, nodes: Node[]): void` Range fallback and `syncText(): void` state synchronization.
- Produces: a paste handler that first invokes `document.execCommand("insertText", false, text)` inside the trusted paste event and falls back to `insertNodesAtCaret` if native insertion fails.

- [x] **Step 1: Write failing tests for native insertion, current paste semantics, fallback, and undo/redo replay**

Add tests that install a temporary `document.execCommand` mock and assert:

```tsx
fireEvent.paste(editor, { clipboardData: { getData: () => "pasted" } });
expect(execCommand).toHaveBeenCalledWith("insertText", false, "pasted");
```

The success mock must insert `**pasted**`, synchronously emit `input`, and verify that the editor keeps raw text rather than creating a `<strong>` node. Separate false-returning and throwing mocks must verify that Range insertion still updates `getText()` and `onChange`. `historyUndo` and `historyRedo` input events must synchronize the restored content without applying a new markdown DOM transform.

- [x] **Step 2: Run the focused test to verify failure**

Run:

```bash
source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && npm -w apps/desktop test -- --run test/prompt-editor.test.tsx
```

Expected: the new native-insertion assertions fail because the current handler only calls `insertNodesAtCaret`.

- [x] **Step 3: Implement the undo-aware paste transaction**

In `PromptEditor`, add refs that mark a synchronous paste edit and whether its `input` event was handled. A paste-originated synchronous `input` event only synchronizes serialized text, preserving the previous paste behavior without applying markdown shortcuts or changing popup state:

```tsx
if (pasteInProgress.current) {
  pasteInputHandled.current = true;
  syncText();
  return;
}
```

The paste handler must:

```tsx
e.preventDefault();
const txt = e.clipboardData.getData("text/plain");
if (!txt || !edRef.current) return;

pasteInProgress.current = true;
pasteInputHandled.current = false;
let inserted = false;
try {
  inserted = document.execCommand("insertText", false, txt);
} catch {
  inserted = false;
} finally {
  pasteInProgress.current = false;
}

if (pasteInputHandled.current) return;
if (!inserted) insertNodesAtCaret(ed, [document.createTextNode(txt)]);
syncText();
```

Ordinary typing continues to apply markdown shortcuts. `historyUndo` and `historyRedo` input events skip those Range-based transforms so Chromium can restore its recorded DOM snapshot without corrupting the redo chain.

- [x] **Step 4: Run focused tests**

Run:

```bash
source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && npm -w apps/desktop test -- --run test/prompt-editor.test.tsx test/mention-editor.test.ts
```

Expected: all focused tests pass.

- [x] **Step 5: Run desktop typecheck, production build, and full tests**

Run:

```bash
source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && npm -w apps/desktop run typecheck
source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && npm -w apps/desktop run build
source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && npm -w apps/desktop test
```

Expected: typecheck and build exit 0 and the complete desktop Vitest suite passes.

- [x] **Step 6: Review the final diff**

Verify that only the plan, prompt editor, and prompt editor tests changed; no dependency, protocol, daemon, or persistence files changed. Leave the worktree uncommitted for user review.
