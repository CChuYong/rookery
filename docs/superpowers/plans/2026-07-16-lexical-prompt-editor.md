# Lexical Prompt Editor Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the home-grown rich `contenteditable` prompt editor with Lexical 0.47.0 so inline file chips, Markdown shortcuts, plain-text paste, IME composition, and undo/redo share one editor state and history engine.

**Architecture:** Lexical owns the DOM, selection, composition, and undo/redo history. A custom inline `FileMentionNode` serializes as `@<absolute-path>` while rendering the existing filename chip, and plugins adapt slash commands, file typeahead, submit behavior, draft synchronization, plain-text paste, and the current imperative Composer bridge. No code outside Lexical may mutate the editor DOM or create browser-native undo transactions.

**Tech Stack:** React 18, TypeScript, Electron 32.3.3 / Chromium 128, Lexical 0.47.0, Vitest, Testing Library, jsdom

## Global Constraints

- Activate Node 22 before every repository command.
- Pin all Lexical packages to exactly `0.47.0` so core and plugin package internals cannot drift.
- Keep inline file chips and serialize each chip as `@<absolute-path>`.
- Clipboard paste must consume only `text/plain`; clipboard HTML must not enter editor state.
- Lexical `HistoryPlugin` is the only undo/redo owner. Do not use `document.execCommand`, direct `Range.insertNode`, `innerHTML`, or direct editor-child DOM mutation.
- Never transform or replace editor state from React while `editor.isComposing()` is true.
- Enter submits only when the editor is not composing; Shift+Enter remains a newline.
- Preserve the existing `PromptEditor` props and serialized string callbacks where practical so `Composer`, `AutomationForm`, draft persistence, and callers do not gain Lexical types.
- Keep the existing Range implementation only until all callers move; remove it from the active prompt path.
- Do not commit or push the UX migration until the user has tested it in the open Electron app.

---

### Task 1: Lexical dependencies and file mention node

**Files:**
- Modify: `apps/desktop/package.json`
- Modify: `package-lock.json`
- Create: `apps/desktop/src/renderer/editor/FileMentionNode.ts`
- Create: `apps/desktop/src/renderer/editor/prompt-serialization.ts`
- Create: `apps/desktop/test/prompt-serialization.test.ts`

**Interfaces:**
- Produces: `FileMentionNode`, `$createFileMentionNode(path: string, name: string)`, `$isFileMentionNode(node)`, and `$serializePrompt(): string`.
- Consumes: Lexical `TextNode`, root/paragraph/text/line-break nodes, and editor-state read transactions.

- [x] **Step 1: Install one synchronized Lexical version set**

Run:

```bash
source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && npm install -w apps/desktop --save-exact lexical@0.47.0 @lexical/react@0.47.0 @lexical/history@0.47.0 @lexical/rich-text@0.47.0 @lexical/markdown@0.47.0 @lexical/list@0.47.0 @lexical/clipboard@0.47.0 @lexical/utils@0.47.0
```

Expected: `apps/desktop/package.json` lists exact `0.47.0` versions and npm updates the root lockfile without unrelated dependency upgrades.

- [x] **Step 2: Write failing node and serialization tests**

Create headless/editor-state tests which register `FileMentionNode`, insert text + a file node + line breaks, and assert:

```ts
expect(serialized).toBe("이거 @/repo/src/a.ts 보고\n다음 줄");
expect(fileNode.getPath()).toBe("/repo/src/a.ts");
expect(fileNode.getTextContent()).toBe("a.ts");
```

- [x] **Step 3: Implement the atomic inline file node**

Implement a segmented text-entity node with JSON round-trip and stable text content. Lexical 0.47.0 specifically preserves the DOM element during IME composition on segmented mention nodes, so use this maintained path instead of an opaque decorator:

```ts
export class FileMentionNode extends TextNode {
  __path: string;
  __name: string;
  static getType(): string { return "file-mention"; }
  isTextEntity(): true { return true; }
  canInsertTextBefore(): false { return false; }
  canInsertTextAfter(): false { return false; }
  getTextContent(): string { return this.__name; }
}
```

The real implementation must provide `clone`, `importJSON`, `exportJSON`, `createDOM`, `updateDOM`, `getPath`, and `getName` with Lexical 0.47.0 signatures. The factory sets segmented mode and `createDOM` reuses the existing `.mention-chip` class while the internal text remains the displayed filename. Keep `getTextContent()` aligned with that filename because Lexical derives selection offsets from it; the prompt serializer, not the node's selection text, emits `@<absolute-path>`.

- [x] **Step 4: Implement canonical prompt serialization**

Walk the Lexical root in document order. Join top-level blocks with one newline, preserve explicit line breaks, emit formatted text as the existing Markdown markers (`**bold**`, `` `code` ``), and use `FileMentionNode.getTextContent()` for attachments. Do not serialize Lexical JSON onto the daemon wire.

- [x] **Step 5: Run focused tests and typecheck**

Run:

```bash
source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && npm -w apps/desktop test -- --run test/prompt-serialization.test.ts
source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && npm -w apps/desktop run typecheck
```

Expected: node/serialization tests and typecheck pass.

---

### Task 2: Lexical-owned PromptEditor core

**Files:**
- Create: `apps/desktop/src/renderer/editor/PromptEditorPlugins.tsx`
- Rewrite: `apps/desktop/src/renderer/components/PromptEditor.tsx`
- Modify: `apps/desktop/test/prompt-editor.test.tsx`

**Interfaces:**
- Consumes: `FileMentionNode`, `$serializePrompt`, existing `PromptEditorProps`, and `PromptEditorHandle`.
- Produces: a `PromptEditor` whose external value remains a serialized string and whose imperative bridge exposes `insertFiles`, `insertText`, `clear`, `focus`, `getText`, and `getElement`.

- [x] **Step 1: Replace DOM-mutation tests with editor-behavior tests**

Tests must cover initial text, `onChange`, Enter submit, Shift+Enter newline, IME Enter suppression, clear/focus/getText, and plain-text paste command behavior. Remove assertions that mock `document.execCommand` or direct Range insertion.

- [x] **Step 2: Build the Lexical shell**

Use `LexicalComposer`, `RichTextPlugin`, `ContentEditable`, `HistoryPlugin`, `OnChangePlugin`, and `LexicalErrorBoundary`. Register `FileMentionNode` in `initialConfig.nodes`; seed `initialText` only through `initialConfig.editorState`; and toggle `editor.setEditable(!disabled)` from a plugin.

- [x] **Step 3: Make paste a single Lexical history transaction**

Register `PASTE_COMMAND` at high priority, call `event.preventDefault()`, extract `event.clipboardData.getData("text/plain")`, add `HISTORY_PUSH_TAG`, and insert plain text through the active Lexical range selection. The handler must not touch DOM selection or browser editing commands.

- [x] **Step 4: Keep IME and submit boundaries explicit**

Register Enter handling through Lexical commands or the root keydown event:

```ts
if (event.isComposing || editor.isComposing()) return false;
if (event.shiftKey) return false;
event.preventDefault();
onSubmit?.();
return true;
```

Composition events remain owned by Lexical. No plugin may normalize state on `compositionstart`, `compositionupdate`, or `compositionend`.

- [x] **Step 5: Bridge serialized drafts and the imperative API**

`OnChangePlugin` reads `$serializePrompt()` and invokes `onChange`. The imperative bridge dispatches Lexical updates tagged with `HISTORY_PUSH_TAG`; attachment insertion creates `FileMentionNode` + trailing text spacing as one transaction.

- [x] **Step 6: Run focused tests and typecheck**

Run:

```bash
source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && npm -w apps/desktop test -- --run test/prompt-editor.test.tsx test/composer-draft.test.tsx test/automation-form.test.tsx
source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && npm -w apps/desktop run typecheck
```

Expected: the migrated editor and its direct consumers pass.

---

### Task 3: Slash commands, file typeahead, and Composer attachments

**Files:**
- Create: `apps/desktop/src/renderer/editor/use-lexical-file-mention.ts`
- Modify: `apps/desktop/src/renderer/components/PromptEditor.tsx`
- Modify: `apps/desktop/src/renderer/components/Composer.tsx`
- Modify: `apps/desktop/test/prompt-editor.test.tsx`
- Modify: `apps/desktop/test/file-mention.test.ts`

**Interfaces:**
- Consumes: existing pure `activeMentionQuery`, `splitPath`, `filterEntries`, `chipPathOf`, `BrowseResult`, `FileMentionPopup`, and slash command matching.
- Produces: Lexical-selection-aware slash replacement and file token replacement without DOM Range operations.

- [ ] **Step 1: Add tests for atomic chip insertion and token replacement**

Cover attachment-button insertion, `@` file selection, slash replacement, serialized output, chip removal with Backspace/Delete, and undo/redo around the inserted token.

- [x] **Step 2: Read query context from Lexical selection**

On editor updates, when the collapsed anchor is inside a text node, read only text before `anchor.offset`; feed it to the existing pure query parsers. Store `{nodeKey,start,end}` instead of a DOM `Text` reference.

- [x] **Step 3: Replace a query with Lexical nodes**

Inside `editor.update`, validate the stored node key and range, construct a Lexical range selection, then replace it with either drill-down text or `FileMentionNode` plus a trailing space. Tag the file selection as a standalone history item.

- [x] **Step 4: Change Composer attachment insertion to semantic data**

Replace `insertNodes(Node[])` and `makeChip()` with:

```ts
promptRef.current?.insertFiles(paths.map((path) => ({ path, name: basename(path) })));
```

Keep drop-point placement when Lexical has a synchronized selection; otherwise insert at the last editor selection/end without mutating DOM ranges.

- [x] **Step 5: Run focused tests**

Run:

```bash
source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && npm -w apps/desktop test -- --run test/prompt-editor.test.tsx test/file-mention.test.ts test/composer-draft.test.tsx
```

Expected: slash, file autocomplete, attachment, draft, and undo tests pass.

---

### Task 4: Markdown shortcuts and cleanup of the old editor engine

**Files:**
- Modify: `apps/desktop/src/renderer/components/PromptEditor.tsx`
- Modify: `apps/desktop/src/renderer/globals.css`
- Delete or reduce: `apps/desktop/src/renderer/lib/mention-editor.ts`
- Delete or reduce: `apps/desktop/src/renderer/lib/use-file-mention.ts`
- Modify: `apps/desktop/test/mention-editor.test.ts`
- Modify: `apps/desktop/test/prompt-serialization.test.ts`

**Interfaces:**
- Consumes: Lexical Markdown shortcut transformers and `$serializePrompt`.
- Produces: the current bold/code/bullet visual behavior with Markdown-equivalent serialized output.

- [x] **Step 1: Add Markdown round-trip tests**

Assert that visually formatted Lexical nodes serialize exactly as:

```ts
"hello **world**\nrun `ls -la`\n- item"
```

Pasted Markdown must remain semantically equivalent and must not import arbitrary clipboard HTML.

- [x] **Step 2: Register only the current shortcut subset**

Use supported `@lexical/markdown` transformers for bold, inline code, and unordered lists. Do not enable headings, links, tables, fenced code blocks, or other editor behavior the current Composer does not expose.

- [x] **Step 3: Remove active direct-DOM editing paths**

After all callers migrate, remove `makeChip`, `insertNodesAtCaret`, `replaceRange`, `setEditorText`, and `applyMarkdownShortcuts` from the prompt path. Keep pure serialization/query utilities only if another caller still imports them.

- [x] **Step 4: Run editor and Markdown tests**

Run:

```bash
source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && npm -w apps/desktop test -- --run test/prompt-editor.test.tsx test/prompt-serialization.test.ts test/mention-editor.test.ts
```

Expected: Markdown visuals and outgoing strings retain existing behavior without direct DOM mutation.

---

### Task 5: Full validation and live Electron QA

**Files:**
- Modify: `docs/superpowers/plans/2026-07-16-lexical-prompt-editor.md`

**Interfaces:**
- Consumes: completed Lexical editor migration.
- Produces: a verified working tree ready for the user's hands-on UX decision.

- [x] **Step 1: Run all static and automated gates**

Run:

```bash
source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && npm -w apps/desktop run typecheck
source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && npm -w apps/desktop test
source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && npm -w apps/desktop run build
```

Expected: typecheck/build exit 0 and all desktop tests pass.

- [x] **Step 2: Verify the actual Electron editing matrix**

In the running development app, verify:

```text
Korean: type 하이 → paste → Cmd+Z → type 안녕
Redo: paste → Cmd+Z → Cmd+Shift+Z → type 안녕
Selection: replace selected text by paste → undo → redo
Composition: Korean composition + Enter does not submit; Shift+Enter creates newline
Chips: attach/drop/@ select → undo → redo → type Korean before and after the chip
Clipboard: copy rich HTML → paste inserts plain text only
History: multiple typing/paste/chip operations undo in reverse transaction order
```

- [x] **Step 3: Review diff and leave it uncommitted for UX testing**

Run `git diff --check`, inspect dependency lock changes, confirm `document.execCommand` is absent from the active editor, and leave the dev app running so the user can decide whether the Lexical feel is acceptable before the PR is updated.
