import type { SessionManager } from "../core/session-manager.js";
import type { EventBus } from "../core/events.js";
import type { SlackClient, SlackFile, ThreadTarget } from "./types.js";
import type { FileDownloader } from "./file-download.js";
import type { SlackInteractionBridge } from "./interaction.js";
import type { SlackThreadReader } from "../tools/slack-thread-tools.js";
import type { SlackRefResolver } from "./name-resolver.js";
import { ThreadRegistry } from "./thread-registry.js";
import { SlackThreadReporter } from "./reporter.js";
import { t, type Locale } from "../core/i18n.js";

// Slack runtime config — resolved from Settings(DB) on every call (live). Tokens are read at connection time, the rest per message.
export interface SlackConfig {
  botToken?: string;
  appToken?: string;
  cwd: string;
  allowedUsers: string[];
  allowAll: boolean;
  refuseReply: boolean; // whether to auto-reply to non-permitted users
  refusalMessage: string; // reply text
  locale: Locale; // Slack output language (resolved from settings.slackLocale())
  workerRelayEnabled: boolean; // mirror Slack-origin masters' worker activity into workerRelayChannel
  workerRelayChannel: string; // Slack channel ID for the worker relay ("" = off)
  provider?: string; // AgentBackend for newly-created slack-origin sessions ("claude"/"codex", from settings.slackProvider()). Absent → getOrCreateByKey/repos.createSession default to "claude". Only applies at first creation of a thread's session (fixed thereafter).
}

export interface SlackDeps {
  sessions: SessionManager;
  bus: EventBus;
  slackConfig: () => SlackConfig; // settings-based resolver instead of config (live)
  home: string; // base of the slack-files directory (config.home)
  // Register the interaction bridge created at connection time into the daemon holder (null when disconnected). For master canUseTool routing.
  setBridge?: (b: SlackInteractionBridge | null) => void;
  // Register the thread reader (conversations.replies) into the daemon holder at connection time (null when disconnected). For the master read_thread capability.
  setThreadReader?: (r: SlackThreadReader | null) => void;
  // Register reporter-ensure (sessionId+external_key → guarantee that thread's reporter) into the daemon holder at connection time (null when disconnected).
  // Called by the dispatcher right before firing → headless turns (wakeup, etc.) of Slack sessions are also delivered to the thread without a human message.
  setReporterFor?: (fn: ((sessionId: string, externalKey: string) => void) | null) => void;
  // Register the channel/user name resolver (conversations.info/users.info) into the daemon holder at connection time
  // (null when disconnected). Backs the automation.resolveSlackRefs request (audit #51 — human-readable rule cards).
  setNameResolver?: (r: SlackRefResolver | null) => void;
  // Owner-scoped release counterparts of the set* holders above: stop() passes ITS OWN instance, and the daemon
  // clears the holder only if it still points at that instance. Without this, a late stop() from a superseded
  // connection (start-timeout → retry succeeded → stale start resolves late) nulls the LIVE connection's holders.
  clearBridge?: (b: SlackInteractionBridge) => void;
  clearThreadReader?: (r: SlackThreadReader) => void;
  clearReporterFor?: (fn: (sessionId: string, externalKey: string) => void) => void;
  clearNameResolver?: (r: SlackRefResolver) => void;
  // Slack message trigger source handler — routes app.message events to the automation dispatcher.
  // ts/threadTs/team are passed to the action as template variables ({{ts}}/{{threadTs}}/{{team}}).
  onMessage?: (e: { channel: string; userId?: string; text: string; ts?: string; threadTs?: string; team?: string }) => Promise<void>;
  // Resolve a session's (master's) Slack thread, or null if the session isn't Slack-origin. For the worker→Slack relay.
  resolveThread?: (sessionId: string) => ThreadTarget | null;
}

export interface IncomingCtx {
  client: SlackClient;
  channel: string;
  threadTs: string;
  team: string;
  userId?: string;
  text: string;
  files?: SlackFile[]; // attached files (if any, download and append to the turn as @paths)
  setStatus: (s: string) => Promise<void>;
}

const NO_FILE = (loc: Locale): string => t(loc, "slack.noFile");
const EMPTY_MSG = (loc: Locale): string => t(loc, "slack.emptyMsg");
// Some (not all) attachments failed to download but there's still text to run on → tell the user, otherwise the bot answers
// from text only and they assume it saw the file.
const PARTIAL_FILE = (loc: Locale, n: number): string => t(loc, "slack.partialFile", { count: n });

// Long-turn heartbeat: Slack assistant status disappears after 2 minutes of inactivity → keep it alive by periodically re-setting it during progress.
export type HeartbeatScheduler = (fn: () => void, ms: number) => () => void;
const HEARTBEAT_MS = 90000; // below the 2-minute timeout
function defaultHeartbeat(fn: () => void, ms: number): () => void {
  const t = setInterval(fn, ms);
  t.unref?.(); // so the heartbeat does not keep the daemon/test process alive
  return () => clearInterval(t);
}

export function threadKey(team: string, channel: string, threadTs: string): string {
  return `slack:${team}:${channel}:${threadTs}`;
}

// Inverse of threadKey (for reconstructing the reporter target). null if not slack-origin or the format is malformed.
// threadTs (e.g. "169...001") is captured as everything after the last colon for safe restoration.
export function parseThreadKey(key: string): { team: string; channel: string; threadTs: string } | null {
  if (!key.startsWith("slack:")) return null;
  const rest = key.slice("slack:".length);
  const i1 = rest.indexOf(":");
  const i2 = rest.indexOf(":", i1 + 1);
  if (i1 < 0 || i2 < 0 || i2 + 1 >= rest.length) return null;
  return { team: rest.slice(0, i1), channel: rest.slice(i1 + 1, i2), threadTs: rest.slice(i2 + 1) };
}

// If the session's external_key is slack-origin, ensure that thread's reporter (if absent). Otherwise no-op.
// Called not only from handleIncoming (human messages) but also from the dispatcher's pre-fire hook → headless turns (wakeup, etc.)
// also get a subscribed reporter and are delivered to Slack. userId is omitted since it's not in the key (recipient hint only, not required).
export function ensureSlackReporter(registry: ThreadRegistry, client: SlackClient, sessionId: string, externalKey: string, getLocale: () => Locale): void {
  const t2 = parseThreadKey(externalKey);
  if (!t2) return;
  registry.ensure(sessionId, () => new SlackThreadReporter(client, { channel: t2.channel, threadTs: t2.threadTs, team: t2.team }, getLocale));
}

// In-flight turn count per session — prevents clearing status early when concurrent messages arrive in the same thread (slack-concurrent-turns-status-race).
const inflight = new Map<string, number>();

export async function handleIncoming(
  ctx: IncomingCtx,
  deps: SlackDeps,
  registry: ThreadRegistry,
  download?: FileDownloader,
  scheduleHeartbeat?: HeartbeatScheduler,
): Promise<void> {
  // Sender allowlist (fail-closed). Pass conditions: ALLOW_ALL, or a user included in the allowlist.
  // Empty allowlist + ALLOW_ALL unset means everyone is denied — so a default deployment is not left wide open.
  // (On refusal, no session/turn is created; only a refusal message is left.)
  const sc = deps.slackConfig();
  const { allowedUsers, allowAll } = sc;
  const permitted = allowAll || (allowedUsers.length > 0 && allowedUsers.includes(ctx.userId ?? ""));
  if (!permitted) {
    // Reply only when refusal auto-reply is on and a message is set (silently ignore when off).
    if (sc.refuseReply && sc.refusalMessage.trim()) await safePost(ctx.client, ctx.channel, ctx.threadTs, sc.refusalMessage);
    return;
  }

  // Download attached files locally and append them to the turn as @paths (same format as desktop attachments → the master handles text/images via Read).
  const attachPaths: string[] = [];
  let failedFiles = 0;
  if (ctx.files?.length && download) {
    for (const f of ctx.files) {
      const p = await download(f).catch(() => null);
      if (p) attachPaths.push(p);
      else failedFiles += 1;
    }
  }
  const turnText = [ctx.text, ...attachPaths.map((p) => `@${p}`)].filter(Boolean).join(" ").trim();
  if (!turnText) {
    // Explain the reason instead of an empty turn: if files arrived but all failed, explain the scope; if the message is entirely empty (e.g. just @rookery), ask for a message.
    const hadFiles = (ctx.files?.length ?? 0) > 0;
    await safePost(ctx.client, ctx.channel, ctx.threadTs, hadFiles ? NO_FILE(sc.locale) : EMPTY_MSG(sc.locale));
    return;
  }
  // Some attachments failed but we still have text to run on → say so (best-effort), instead of silently answering from text only.
  if (failedFiles > 0) await safePost(ctx.client, ctx.channel, ctx.threadTs, PARTIAL_FILE(sc.locale, failedFiles));

  const key = threadKey(ctx.team, ctx.channel, ctx.threadTs);
  const session = deps.sessions.getOrCreateByKey(key, sc.cwd, sc.provider);
  registry.ensure(
    session.id,
    () =>
      new SlackThreadReporter(
        ctx.client,
        { channel: ctx.channel, threadTs: ctx.threadTs, team: ctx.team, userId: ctx.userId },
        () => deps.slackConfig().locale,
      ),
  );

  // Wrap setStatus as best-effort — a failure must not break the turn (slack-setstatus-failure).
  const setStatus = async (s: string) => {
    try { await ctx.setStatus(s); } catch { /* best-effort */ }
  };

  inflight.set(session.id, (inflight.get(session.id) ?? 0) + 1);
  await setStatus("thinking…");
  // Periodically refresh status during a long turn so it doesn't disappear on the 2-minute timeout (UX-14).
  const stopBeat = (scheduleHeartbeat ?? defaultHeartbeat)(() => { void setStatus("thinking…"); }, HEARTBEAT_MS);
  try {
    await session.master.runTurn(turnText);
  } catch {
    // A turn failure is already surfaced to the thread by the reporter via the EventBus 'error' event → posting again here would be a duplicate (MS-2).
  } finally {
    stopBeat(); // stop the heartbeat (before clearing status)
    const n = (inflight.get(session.id) ?? 1) - 1;
    if (n <= 0) {
      inflight.delete(session.id);
      await setStatus(""); // clear status only when the last in-flight turn finishes
    } else {
      inflight.set(session.id, n);
    }
  }
}

async function safePost(client: SlackClient, channel: string, threadTs: string, text: string): Promise<void> {
  try {
    await client.chat.postMessage({ channel, thread_ts: threadTs, text });
  } catch {
    /* ignore */
  }
}
