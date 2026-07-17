# masterName in Slack surfaces — design

Date: 2026-07-17
Status: approved (user-specified scope)

## Problem

The `masterName` setting only reaches the master's system prompt ("You are
{{NAME}}…"). Three Slack-facing surfaces stay hardcoded to "rookery", so renaming
the agent leaves a visible mismatch.

## Changes (exactly three surfaces)

1. **Assistant thread title** (`src/slack/app.ts` `threadStarted`): `setTitle`
   uses the live-resolved name. `SlackConfig` gains optional `name?: string`
   (optional so existing test fakes stay valid); the server.ts `slackConfig`
   builder adds `name: settings.masterName()` (Settings already defaults empty →
   "rookery"). `threadStarted` resolves `deps.slackConfig()` live (name AND
   locale — the greeting previously used the connect-time snapshot; live matches
   the per-message resolution ethos).
2. **Greeting** (`src/core/i18n.ts` `slack.greeting` ko/en): parameterized with
   `{name}` and rendered with the same live name.
3. **Transcript bot label** (`src/tools/slack-tools.ts` `formatTranscript`
   `"rookery(bot)"`): the label becomes `<name>(bot)`. `slackToolDefs` /
   `makeSlackCapabilities` gain an optional `getName?: () => string` resolved per
   call (live settings); absent → "rookery" (existing tests unchanged). The
   read impls (`readThreadImpl`/`readChannelImpl`) take an optional trailing
   `botName` param with the same default. server.ts passes
   `() => settings.masterName()`.

## Testing

- i18n: greeting renders the `{name}` param in ko/en.
- slack-tools: injected name shows as `Jenny(bot)`; default stays `rookery(bot)`.
- capabilities: `getName` flows through to the defs (custom label visible via the
  read_thread handler).

## Out of scope

Desktop/CLI branding, worker→Slack relay card labels, the Slack app's own display
name (Slack admin console owns it).
