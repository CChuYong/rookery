# Side Slash Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open the existing Side conversation drawer by submitting `/btw <question>` or `/side <question>`, with both commands visible in slash autocomplete.

**Architecture:** Keep these commands renderer-local because they control desktop UI state rather than an agent provider command. `ConversationPane` prepends localized command definitions to the active conversation's command catalog, and `Composer` parses the submitted text and redirects only a leading `/btw` or `/side` command to its existing `onSideSend` callback.

**Tech Stack:** React 18, TypeScript, PromptEditor slash autocomplete, renderer i18n, Vitest, Testing Library.

## Global Constraints

- `/btw` and `/side` must behave identically.
- The commands appear only when a Side conversation can be started and no Side drawer is already open.
- Existing provider commands remain visible and keep their current ordering after the two local commands.
- A command is recognized only as the first trimmed token and only when followed by whitespace or end-of-input; `/sideways` remains a normal message.
- A command without a question does not send or clear the draft.
- All visible command descriptions and argument hints have matching Korean and English i18n keys.

---

### Task 1: Command parsing and Composer routing

**Files:**
- Modify: `apps/desktop/src/renderer/components/Composer.tsx`
- Test: `apps/desktop/test/composer-draft.test.tsx`

**Interfaces:**
- Produces `parseSideCommand(text: string): { command: "btw" | "side"; question: string } | null`.
- Reuses `ComposerProps.onSideSend(text)`; no new callback is introduced.

- [ ] **Step 1: Write failing parser and routing tests**

```ts
expect(parseSideCommand("/btw why?")).toEqual({ command: "btw", question: "why?" });
expect(parseSideCommand(" /side explain this ")).toEqual({ command: "side", question: "explain this" });
expect(parseSideCommand("/sideways hello")).toBeNull();
```

Render `Composer` with both callbacks, submit `/btw why?`, and assert only `onSideSend("why?")` fires and the editor clears. Submit `/side ` and assert neither callback fires and the editor remains unchanged.

- [ ] **Step 2: Run the tests and verify failure**

Run: `npm -w apps/desktop test -- --run test/composer-draft.test.tsx`

Expected: FAIL because `parseSideCommand` and slash routing do not exist.

- [ ] **Step 3: Implement parser and submission branch**

```ts
export function parseSideCommand(text: string) {
  const match = /^\/(btw|side)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  return { command: match[1] as "btw" | "side", question: (match[2] ?? "").trim() };
}
```

In `submit`, call `onSideSend(parsed.question)` only when the question is non-empty; otherwise return without clearing.

- [ ] **Step 4: Re-run the Composer tests**

Expected: PASS.

### Task 2: Slash autocomplete catalog

**Files:**
- Modify: `apps/desktop/src/renderer/components/ConversationPane.tsx`
- Modify: `apps/desktop/src/renderer/i18n/locales/ko/sideConversation.ts`
- Modify: `apps/desktop/src/renderer/i18n/locales/en/sideConversation.ts`
- Test: `apps/desktop/test/conversation-pane.test.tsx`

**Interfaces:**
- Supplies two `SlashCommand` entries named `btw` and `side` to the existing `Conversation.commands` prop.
- Filters provider entries with those names before prepending local entries, preventing duplicate popup rows.

- [ ] **Step 1: Write failing autocomplete tests**

Type `/` in a Side-capable `ConversationPane` and assert `/btw <question>` and `/side <question>` are visible alongside an injected existing command. Open a Side drawer and assert the local commands disappear from the main composer.

- [ ] **Step 2: Run the component and i18n tests and verify failure**

Run: `npm -w apps/desktop test -- --run test/conversation-pane.test.tsx test/i18n/catalog.test.ts test/i18n/used-keys.test.ts`

Expected: FAIL because local Side commands are not merged.

- [ ] **Step 3: Add localized definitions and merge them in ConversationPane**

```ts
const local = [
  { name: "btw", description: t("sideConversation.commandDescription"), argumentHint: t("sideConversation.commandArgumentHint") },
  { name: "side", description: t("sideConversation.commandDescription"), argumentHint: t("sideConversation.commandArgumentHint") },
];
const merged = [...local, ...commands.filter((c) => c.name !== "btw" && c.name !== "side")];
```

Pass `merged` only while `onSideStart && !side`; otherwise pass the unmodified provider commands.

- [ ] **Step 4: Re-run component and i18n tests**

Expected: PASS.

### Task 3: Verification and follow-up PR

**Files:**
- Modify only files required by failures caused by this change.

**Interfaces:**
- No new interface; validates the complete renderer-only change.

- [ ] **Step 1: Run desktop tests and typecheck**

Run: `npm -w apps/desktop test && npm -w apps/desktop run typecheck`

Expected: PASS.

- [ ] **Step 2: Run the production desktop build**

Run: `npm -w apps/desktop run build`

Expected: PASS.

- [ ] **Step 3: Commit and open the follow-up PR**

```bash
git commit -m "feat: add Side slash commands"
git push -u origin feat/side-slash-commands
gh pr create --base main --head feat/side-slash-commands
```
