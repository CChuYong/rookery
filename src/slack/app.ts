import { App, Assistant, LogLevel } from "@slack/bolt";
import path from "node:path";
import type { SlackDeps, IncomingCtx } from "./handle-incoming.js";
import { handleIncoming, ensureSlackReporter } from "./handle-incoming.js";
import { ThreadRegistry } from "./thread-registry.js";
import type { SlackClient, SlackFile, ThreadTarget } from "./types.js";
import { makeFileDownloader } from "./file-download.js";
import { SlackInteractionBridge, INTERACTION_ACTION_RE } from "./interaction.js";
import { redactOnReaction } from "./redaction.js";
import { makeSlackThreadReader } from "./thread-reader.js";
import { makeSlackRefResolver } from "./name-resolver.js";
import { WorkerSlackRelay } from "./worker-slack-relay.js";
import { FLEET_CHANNEL } from "../core/events.js";
import { isTriggerableMessage, extractSlackText, type RawSlackMessage } from "./message-text.js";
import { t } from "../core/i18n.js";

export interface SlackHandle {
  stop(): Promise<void>;
}

// Raw files array from a Slack event → normalized SlackFile[] (drop items without an id; prefer the _download URL for the download URL).
type RawFile = { id?: string; name?: string; mimetype?: string; url_private_download?: string; url_private?: string };
function toSlackFiles(raw?: RawFile[]): SlackFile[] | undefined {
  const files = (raw ?? [])
    .filter((f): f is RawFile & { id: string } => typeof f.id === "string")
    .map((f) => ({ id: f.id, name: f.name, mimetype: f.mimetype, urlPrivateDownload: f.url_private_download ?? f.url_private }));
  return files.length ? files : undefined;
}

export async function startSlack(deps: SlackDeps): Promise<SlackHandle | null> {
  const cfg = deps.slackConfig();
  if (!cfg.botToken || !cfg.appToken) return null;

  // fail-closed default notice: if there is neither an allowlist nor allowAll, nobody gets a response — warn so it isn't silently blocked.
  if (cfg.allowedUsers.length === 0 && !cfg.allowAll) {
    process.stderr.write(
      "[rookery] Slack is enabled but the allowed-users list is empty and allow-all is off — " +
        "ALL Slack messages will be refused. Set the allowed users or enable allow-all in settings.\n",
    );
  }

  const app = new App({
    token: cfg.botToken,
    appToken: cfg.appToken,
    socketMode: true,
    logLevel: LogLevel.INFO,
  });

  const registry = new ThreadRegistry(deps.bus);
  // Last human user id per Slack thread → used as recipient_user_id when streaming the worker relay's cards into a
  // regular channel (chat.startStream needs it outside assistant threads, where the recipient is implicit). Key: team:channel:threadTs.
  const recipientByThread = new Map<string, string>();
  const threadKeyOf = (t: { team: string; channel: string; threadTs: string }): string => `${t.team}:${t.channel}:${t.threadTs}`;
  // Attachment downloader (Bearer bot token → ~/.rookery/slack-files/). Requires the files:read scope.
  const download = makeFileDownloader({ token: cfg.botToken, dir: path.join(deps.home, "slack-files") });

  // Interaction bridge (approval/AskUserQuestion buttons): master canUseTool → post a Slack block, button click → resolve.
  const bridge = new SlackInteractionBridge(async (target: ThreadTarget, m: { text: string; blocks: unknown[] }) => {
    await app.client.chat.postMessage({ channel: target.channel, thread_ts: target.threadTs, text: m.text, blocks: m.blocks as never });
  }, () => deps.slackConfig().locale);
  deps.setBridge?.(bridge);
  // Button click (Socket Mode block_actions) → ack, then forward to the bridge. When the interaction is done, replace that message
  // with a single result line (removing the buttons) → fixes the problem of buttons staying live after a click.
  app.action(INTERACTION_ACTION_RE, async ({ ack, action, body, client }) => {
    await ack();
    const value = (action as { value?: string }).value;
    if (!value) return;
    const res = bridge.handleAction(value);
    if (!res?.done) return;
    const b = body as { channel?: { id?: string }; message?: { ts?: string } };
    const channel = b.channel?.id;
    const ts = b.message?.ts;
    if (!channel || !ts) return;
    try {
      await client.chat.update({ channel, ts, text: res.summary, blocks: [{ type: "section", text: { type: "mrkdwn", text: res.summary } }] as never });
    } catch { /* best-effort: even if the message update fails, the interaction is already handled */ }
  });

  // Redact a bot message via the :x: reaction (block sensitive info). When an allowlisted user adds :x: to a bot-authored message,
  // its body is replaced with the redaction marker. Gating/failure handling is owned entirely by redactOnReaction (best-effort).
  app.event("reaction_added", async ({ event, client, context }) => {
    const e = event as {
      reaction: string;
      item?: { type?: string; channel?: string; ts?: string };
      item_user?: string;
      user?: string;
    };
    if (e.item?.type !== "message" || !e.item.channel || !e.item.ts) return;
    await redactOnReaction(
      { reaction: e.reaction, channel: e.item.channel, ts: e.item.ts, itemUser: e.item_user, reactingUser: e.user, botUserId: context.botUserId },
      {
        slackConfig: () => deps.slackConfig(),
        locale: () => deps.slackConfig().locale,
        update: (a) => client.chat.update({ channel: a.channel, ts: a.ts, text: a.text, blocks: a.blocks as never }),
      },
    );
  });

  const assistant = new Assistant({
    threadStarted: async ({ setTitle, setStatus, say }) => {
      await setTitle("rookery");
      await setStatus("");
      await say(t(cfg.locale, "slack.greeting"));
    },
    userMessage: async ({ message, client, setStatus, context }) => {
      const m = message as { text?: string; thread_ts?: string; ts: string; channel: string; user?: string; files?: RawFile[] };
      const ctx: IncomingCtx = {
        client: client as unknown as SlackClient,
        channel: m.channel,
        threadTs: m.thread_ts ?? m.ts,
        team: context.teamId ?? "unknown",
        userId: m.user,
        text: (m.text ?? "").trim(),
        files: toSlackFiles(m.files),
        setStatus: async (s) => {
          await setStatus(s);
        },
      };
      if (ctx.userId) recipientByThread.set(threadKeyOf(ctx), ctx.userId);
      if (ctx.text || ctx.files?.length) await handleIncoming(ctx, deps, registry, download);
    },
  });
  app.assistant(assistant);

  app.event("app_mention", async ({ event, client, context }) => {
    const e = event as { text: string; channel: string; thread_ts?: string; ts: string; user?: string; files?: RawFile[] };
    const text = e.text.replace(/<@[A-Z0-9]+>/g, "").trim();
    const threadTs = e.thread_ts ?? e.ts;
    const ctx: IncomingCtx = {
      client: client as unknown as SlackClient,
      channel: e.channel,
      threadTs,
      team: context.teamId ?? "unknown",
      userId: e.user,
      text,
      files: toSlackFiles(e.files),
      setStatus: async (status) => {
        try {
          await (
            client as unknown as {
              assistant: {
                threads: {
                  setStatus(a: { channel_id: string; thread_ts: string; status: string }): Promise<unknown>;
                };
              };
            }
          ).assistant.threads.setStatus({ channel_id: e.channel, thread_ts: threadTs, status });
        } catch {
          /* app_mention channels may not support assistant status — ignore */
        }
      },
    };
    // Let empty mentions (just @rookery) through too, so handleIncoming prompts the user to add a message (prevents a silent drop).
    if (ctx.userId) recipientByThread.set(threadKeyOf(ctx), ctx.userId);
    await handleIncoming(ctx, deps, registry, download);
  });

  // Our own bot's bot_id — needed to exclude only our own messages from triggers (prevents a feedback loop) while letting other bots through.
  // Fetched once via the web API before app.start() (client is usable even before the socket connects). Proceed best-effort even if it fails.
  let selfBotId: string | undefined;
  try { selfBotId = ((await app.client.auth.test()) as { bot_id?: string }).bot_id; } catch { /* best-effort */ }

  // Slack message trigger source: exclude only our own bot / edits·deletes etc., and forward user + other-bot/integration messages to the automation dispatcher.
  // Melts down Block Kit blocks / attachments / rich_text to text as well, for use in matching and {{message}}.
  app.message(async ({ message, context }) => {
    const m = message as RawSlackMessage & { channel: string; ts?: string; thread_ts?: string };
    if (!isTriggerableMessage(m, selfBotId)) return;
    const text = extractSlackText(m);
    if (!text) return; // skip if there is no extracted text (e.g. divider only)
    // Pass ts/threadTs/team as identifier template variables (threadTs falls back to the message ts when there is no thread — the reply anchor).
    await deps.onMessage?.({ channel: m.channel, userId: m.user, text, ts: m.ts, threadTs: m.thread_ts ?? m.ts, team: context.teamId });
  });

  // Register the thread-context reader (conversations.replies) on the daemon holder → used by the master's read_thread capability.
  const threadReader = makeSlackThreadReader(app.client as unknown as Parameters<typeof makeSlackThreadReader>[0]);
  deps.setThreadReader?.(threadReader);

  // Register the channel/user name resolver (conversations.info/users.info) on the daemon holder → backs
  // automation.resolveSlackRefs (audit #51). Its cache lives for this connection only (reconnect → fresh resolver).
  const nameResolver = makeSlackRefResolver(app.client as unknown as Parameters<typeof makeSlackRefResolver>[0]);
  deps.setNameResolver?.(nameResolver);

  // Register reporter-ensure on the daemon holder → the dispatcher calls it right before firing, so that headless turns of a Slack session (wakeup, etc.)
  // also get a subscribed reporter delivering to the thread without a human message (prevents lost firings before the first message after restart/reconnect).
  const reporterFor = (sessionId: string, externalKey: string) =>
    ensureSlackReporter(registry, app.client as unknown as SlackClient, sessionId, externalKey, () => deps.slackConfig().locale);
  deps.setReporterFor?.(reporterFor);

  // Worker → Slack relay: mirror each Slack-origin master's workers into the configured channel (subscribed to the fleet channel).
  const workerRelay = new WorkerSlackRelay({
    client: app.client as unknown as SlackClient,
    enabled: () => deps.slackConfig().workerRelayEnabled,
    channel: () => deps.slackConfig().workerRelayChannel,
    resolveThread: (id) => {
      const t = deps.resolveThread?.(id) ?? null;
      return t ? { ...t, userId: recipientByThread.get(threadKeyOf(t)) } : null; // attach recipient_user_id so the relay can stream in a regular channel
    },
    getLocale: () => deps.slackConfig().locale,
  });
  const unsubWorkerRelay = deps.bus.subscribe(FLEET_CHANNEL, (e) => workerRelay.onEvent(e));

  await app.start();

  return {
    stop: async () => {
      bridge.dispose(); // resolve pending approval prompts with deny — a discarded bridge can never be answered
      // Owner-scoped release: a late stop() from a superseded connection must not null holders a newer
      // connection re-installed. Fall back to unconditional set*(null) only when clear* isn't wired (tests).
      if (deps.clearBridge) deps.clearBridge(bridge); else deps.setBridge?.(null);
      if (deps.clearThreadReader) deps.clearThreadReader(threadReader); else deps.setThreadReader?.(null);
      if (deps.clearReporterFor) deps.clearReporterFor(reporterFor); else deps.setReporterFor?.(null);
      if (deps.clearNameResolver) deps.clearNameResolver(nameResolver); else deps.setNameResolver?.(null);
      unsubWorkerRelay();
      void workerRelay.dispose();
      registry.disposeAll();
      await app.stop();
    },
  };
}
