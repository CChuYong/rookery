# Slack transcript fidelity (blocks melting + attachments + download_file) — design

Date: 2026-07-17
Status: approved (approach A)

## Problem

`read_thread`/`read_channel` transcripts read only `m.text`. Block Kit blocks,
legacy attachments, and rich_text content are invisible (CI/monitoring bot cards
show as empty), and file/image attachments don't appear at all — a message that is
only an image is silently skipped. Reactions are explicitly out of scope.

## Decisions

- **Approach A**: melt blocks/attachments into the transcript text, annotate file
  attachments as inline markers, and add an on-demand `download_file` tool so the
  master can open a specific file locally (images via Read). No auto-download of
  every attachment (too heavy), no metadata-only stop (can't see image content).
- Still zero Slack-side writes; `download_file` only writes local files under
  `~/.rookery/slack-files/` (the same directory and downloader the incoming-message
  path already uses).

## Design

### 1. Text melting (`src/slack/read-ops.ts`)

`repliesToThreadMsgs` extracts text with the existing pure `extractSlackText`
(`src/slack/message-text.ts`: text + Block Kit blocks + attachments, rich_text
deduped against m.text) instead of `m.text`. `RawReply` gains
`blocks?: unknown[]; attachments?: unknown[]; files?: RawReplyFile[]`.

### 2. Attachment markers (`src/tools/slack-tools.ts`)

- `ThreadMsg` gains `files?: { id: string; name?: string; mimetype?: string }[]`
  (mapped from the raw `files` array, entries without an id dropped).
- `formatTranscript` appends ` [file: <name> (<mimetype>) id=<id>]` markers to the
  message's line. A message with files but no text is **no longer skipped** — it
  renders as the author label plus markers. Markers count against the per-message
  byte budget.

### 3. `download_file` tool (sixth tool, server `"slack"`)

- Input: `{ file_id: string }` (the id shown in the marker).
- `SlackReadOps` gains `downloadFile(fileId: string): Promise<string | null>`:
  `files.info` → build a `SlackFile` (`url_private_download ?? url_private`) → the
  injected `FileDownloader` → absolute local path, or null when the file/URL/token
  is unavailable.
- Tool result: the local path plus "use Read to view it"; failures follow the
  guidance-string pattern (`isError: true`, never kills the turn): Slack
  disconnected / unknown file id / download failed (likely missing `files:read`).
- `SLACK_TOOL_NAMES` grows to six; `readOnlyHint: true` stays (no Slack mutation).
- `makeSlackReadOps(client, download?)` — `src/slack/app.ts` passes the
  `makeFileDownloader` instance it already builds at connect time.

### 4. Hint and docs

`SLACK_THREAD_HINT` gains: attachments appear as `[file: … id=…]` markers — call
`download_file` with the id, then Read the returned local path (works for images).
AGENTS.md slack bullet mentions `download_file` and its `files:read` dependency.

### 5. Testing

- slack-tools: blocks-only message melted into transcript; file markers rendered;
  file-only message kept; `download_file` success/disconnected/unknown-id/failed
  download guidance; tool-name sync (6 names).
- read-ops: `extractSlackText` wiring (blocks/attachments visible), files mapping,
  `files.info` → downloader call chain, no-downloader → null.
- capabilities: five → six tool names.

## Out of scope

Reactions; auto-downloading all thread attachments; write tools.
