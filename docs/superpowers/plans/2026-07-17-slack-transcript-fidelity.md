# Slack Transcript Fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** read_thread/read_channel transcripts include Block Kit/attachment text and file markers; a new `download_file` tool fetches a marked file locally for Read.

**Architecture:** Spec `docs/superpowers/specs/2026-07-17-slack-transcript-fidelity-design.md`. Melting happens in the adapter (`read-ops.ts`, reusing `extractSlackText`); markers/budgets/tool in the pure tool module (`slack-tools.ts`); downloader injected from `app.ts` (the instance already built for incoming messages).

**Tech Stack:** TypeScript ESM NodeNext, zod raw shapes, vitest.

## Global Constraints

- Errors return guidance strings with `isError: true` — a tool call never kills the turn.
- `SLACK_TOOL_NAMES` must list all six `mcp__slack__*` names in registration order.
- Byte budgets unchanged: 8000 total / 1000 per message / 50 messages, newest-first fill.
- No Slack-side writes; `download_file` writes only under the injected downloader's dir (`~/.rookery/slack-files/`).
- Code comments in English. Gates: `npm run typecheck` && `npm test` on Node 22.

---

### Task 1: slack-tools.ts — file markers, file-only messages, download_file

**Files:** Modify `src/tools/slack-tools.ts`, `test/tools/slack-tools.test.ts`.

**Interfaces produced:**
- `ThreadMsg` gains `files?: ThreadMsgFile[]` where `export interface ThreadMsgFile { id: string; name?: string; mimetype?: string }`.
- `SlackReadOps` gains `downloadFile(fileId: string): Promise<string | null>`.
- `export async function downloadFileImpl(getOps, fileId: string): Promise<ToolText>`.
- `SLACK_TOOL_NAMES` = 6 entries (`download_file` appended).

**Steps (TDD):**
- [ ] Failing tests: (a) formatTranscript renders ` [file: shot.png (image/png) id=F1]` after the message text; (b) a message with files and empty text is kept (renders label + marker only); (c) `downloadFileImpl` returns the local path text on success, DISCONNECTED when holder empty, guidance when `downloadFile` returns null ("files:read"), guidance when it throws; (d) tool-name sync test expects six names ending with `download_file`; (e) disconnected-handler loop covers `download_file` with `{ file_id: "F1" }`.
- [ ] Implement:
  - `formatTranscript`: line = `label: text` + markers; filter drops a message only when it has neither text nor files; marker text `[file: ${name ?? id}${mimetype ? ` (${mimetype})` : ""} id=${id}]` joined by spaces (empty-text case: `label: [file: …]`).
  - `downloadFileImpl`: ops null → DISCONNECTED; `ops.downloadFile(fileId.trim())` → path ? `{ text: `Downloaded to ${path} — use the Read tool to view it (images too).` }` : `{ text: "Couldn't download that file — check the file id (from the [file: … id=…] marker) and that the Slack app has the files:read scope.", isError: true }`; catch → `guideError(err, `file ${fileId}`)`.
  - New def after `get_permalink`: name `download_file`, description "Download a file attached to a Slack message (the [file: … id=…] markers in read_thread/read_channel output) to a local path, then use Read to view it. Works for images.", input `{ file_id: z.string().describe("Slack file id from a [file: … id=F…] marker") }`, readOnlyHint true.
- [ ] `npx vitest run test/tools/slack-tools.test.ts` → PASS; commit `feat(slack): render attachment markers and add download_file tool`.

### Task 2: read-ops.ts — melting + files mapping + files.info download chain

**Files:** Modify `src/slack/read-ops.ts`, `test/slack/read-ops.test.ts`.

**Interfaces produced:**
- `RawReply` gains `blocks?: unknown[]; attachments?: unknown[]; files?: { id?: string; name?: string; mimetype?: string }[]`.
- `SlackReadClient` gains `files: { info(a: { file: string }): Promise<{ file?: { id?: string; name?: string; mimetype?: string; url_private_download?: string; url_private?: string } }> }`.
- `makeSlackReadOps(client: SlackReadClient, download?: FileDownloader)` (import type from `./file-download.js`).

**Steps (TDD):**
- [ ] Failing tests: (a) `repliesToThreadMsgs` melts a blocks-only message (section text visible) and maps `files` (id required, name/mimetype through); (b) `downloadFile` calls `files.info` then the downloader with `{ id, name, mimetype, urlPrivateDownload }` (url_private_download preferred, url_private fallback) and returns its path; (c) returns null when files.info has no file; (d) returns null when no downloader injected.
- [ ] Implement: `repliesToThreadMsgs` uses `extractSlackText({ text: m.text, blocks: m.blocks, attachments: m.attachments })` (import from `./message-text.js`); files mapping drops id-less entries; `downloadFile` per above.
- [ ] `npx vitest run test/slack/read-ops.test.ts` → PASS; commit `feat(slack): melt blocks/attachments and add file download chain to read-ops`.

### Task 3: hint, wiring, docs, gates

**Files:** Modify `src/slack/capabilities.ts`, `test/slack/capabilities.test.ts`, `src/slack/app.ts`, `AGENTS.md`.

**Steps:**
- [ ] capabilities test expects six def names (append `download_file`); `SLACK_THREAD_HINT` gains: "Attachments show up as [file: … id=…] markers — call download_file with the id, then use Read on the returned local path (works for images)."
- [ ] `app.ts`: `makeSlackReadOps(app.client as unknown as SlackReadClient, download)` (the `download` const already exists above).
- [ ] AGENTS.md slack tools bullet: add `download_file` to the name list and note attachments/blocks now render in transcripts (files:read powers download_file).
- [ ] `npm run typecheck` && `npm test` → clean/PASS; commit `feat(slack): wire transcript fidelity (hint, downloader injection, docs)`.
