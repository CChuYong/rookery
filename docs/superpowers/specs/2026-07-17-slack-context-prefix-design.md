# Slack turn context prefix (sender/channel) — design

Date: 2026-07-17
Status: approved

## Problem

A Slack-origin master knows it lives in a Slack thread (SLACK_THREAD_HINT) but not
**who** sent the current message or **which** channel/thread it is in — the turn
text is the raw message only. The model can't address the sender, pass the right
ts to get_permalink, or reason about "this channel" without calling read_thread
first.

## Design

`handleIncoming` prepends a one-line origin header to every Slack turn:

```
[Slack] sender: clover (U0123) · channel: #general (C0123) · thread: 1700.123

<original message text + @attachment paths>
```

- **Placement — turn text, not system prompt:** the sender varies per message
  (multi-user threads); `makeSlackCapabilities` only knows the externalKey. The
  header therefore rides the turn, keeping one implementation point.
- **Name resolution:** reuse the connection-scoped `makeSlackRefResolver`
  (conversations.info / users.info, cached). `IncomingCtx` gains
  `nameResolver?: SlackRefResolver`; `app.ts` sets it at both call sites
  (assistant + app_mention). Lookup failure → raw ids only (best-effort).
- **Sanitization:** display/channel names are user-controlled → collapse
  whitespace to single spaces and byte-cap at 80 (`truncateBytes`) so the header
  stays structurally one line. No heavier fencing: the body that follows is the
  user's instruction anyway.
- **Shape rules:** `sender:` omitted when `userId` is absent; names render as
  `name (ID)` / `#name (CID)`, unresolved → bare id; `thread: <threadTs>` always
  present. The empty-turn check still runs on the original composition (a header
  must not turn an empty message into a turn).
- **Visible side effect (accepted):** the header is part of the persisted turn
  text, so the desktop transcript of a Slack session shows it in the user echo.

## Testing

handle-incoming: header present in the captured prompt (resolved names,
unresolved fallback, no-resolver fallback, sender omitted without userId,
sanitization of a multiline name); existing exact-prompt assertions updated.

## Out of scope

Slack-specific output-format guidance (mrkdwn); metadata for the automation
trigger path (already fenced `{{user}}`/`{{channel}}` vars).
