# Skill Import Dialog Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render every Skill Import field as a full-width vertical form control and keep the directory picker usable at narrow widths.

**Architecture:** Keep the fix local to `SkillImportDialog`: introduce the same small vertical `Field` wrapper already used by the neighboring MCP builder, then give the directory input the flexible slot and the button a fixed slot. Add DOM contract assertions because jsdom cannot calculate visual layout.

**Tech Stack:** React 18, TypeScript, Tailwind CSS v4, Vitest, Testing Library

## Global Constraints

- Do not change the shared `Input` defaults; many compact rows intentionally rely on intrinsic or flex-controlled widths.
- Preserve nested-label accessibility so existing `getByLabelText` behavior remains intact.
- Keep the fix scoped to the Skill Import dialog and its tests.

---

### Task 1: Lock the form layout contract and fix the dialog

**Files:**
- Modify: `apps/desktop/test/capability-library-tab.test.tsx`
- Modify: `apps/desktop/src/renderer/components/capabilities/SkillImportDialog.tsx`

**Interfaces:**
- Consumes: existing `Input`, `Textarea`, and `Button` primitives
- Produces: vertical field groups with full-width controls and a responsive directory row

- [x] **Step 1: Write the failing layout-contract assertions**

Extend the existing `imports a skill snapshot into the Catalog` test immediately after locating the dialog:

```tsx
const nameInput = within(dialog).getByLabelText("이름");
const descriptionInput = within(dialog).getByLabelText("설명");
const directoryInput = within(dialog).getByLabelText("스킬 디렉터리");
const directoryButton = within(dialog).getByRole("button", { name: "디렉터리 선택" });
expect(nameInput).toHaveClass("w-full");
expect(nameInput.closest("label")).toHaveClass("flex", "flex-col");
expect(descriptionInput).toHaveClass("w-full");
expect(directoryInput).toHaveClass("min-w-0", "flex-1");
expect(directoryButton).toHaveClass("shrink-0");
```

- [x] **Step 2: Run the focused test and confirm it fails**

Run: `npm -w apps/desktop test -- --run test/capability-library-tab.test.tsx`

Expected: FAIL because the name input lacks `w-full` and the directory controls lack their flex sizing classes.

- [x] **Step 3: Implement the vertical field layout**

Add a local wrapper and use it for Name, ID, and Description:

```tsx
function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return <label className="flex min-w-0 flex-col gap-1 text-[10.5px] font-medium text-fg-dim"><span>{label}</span>{children}</label>;
}

<Field label={t("capabilityCatalog.name")}>
  <Input className="w-full" ... />
</Field>
```

Apply `w-full` to the ID and Description controls. In the directory row, apply `min-w-0 flex-1` to the read-only input and `shrink-0` to the choose-directory button.

- [x] **Step 4: Run focused tests and typecheck**

Run: `npm -w apps/desktop test -- --run test/capability-library-tab.test.tsx`

Expected: PASS.

Run: `npm -w apps/desktop run typecheck`

Expected: exit code 0.

- [x] **Step 5: Verify the live dialog and full Desktop suite**

Open Skill Import in the already-running development app and confirm labels stack above full-width controls, while the directory button remains visible. Then run:

```bash
npm -w apps/desktop test
npm -w apps/desktop run build
git diff --check
```

Expected: all commands exit successfully.

- [x] **Step 6: Commit and open the PR**

```bash
git add apps/desktop/src/renderer/components/capabilities/SkillImportDialog.tsx apps/desktop/test/capability-library-tab.test.tsx docs/superpowers/plans/2026-07-16-skill-import-dialog-layout.md
git commit -m "fix(desktop): repair skill import form layout"
git push -u origin fix/skill-import-dialog-layout
gh pr create --base main --head fix/skill-import-dialog-layout --title "fix(desktop): repair skill import form layout"
```
