import type { SlackConfig } from "./handle-incoming.js";
import { t, type Locale } from "../core/i18n.js";

// The Slack standard reaction name for :x:. When this reaction is added to a bot message, the body is replaced with the marker.
export const REDACT_REACTION = "x";
// The marker left behind after redaction. Prevents sensitive-info leakage — the original is not retained, so it cannot be restored.
export function redactedMarker(locale: Locale): string { return t(locale, "slack.redactedMarker"); }

export interface RedactReactionArgs {
  reaction: string;
  channel: string;
  ts: string; // ts of the message the reaction was added to
  itemUser?: string; // event.item_user (message author)
  reactingUser?: string; // event.user (the person who added the reaction)
  botUserId?: string; // context.botUserId
}

export interface RedactDeps {
  // Reuse the same fail-closed allowlist gate as message reception (live resolver).
  slackConfig: () => Pick<SlackConfig, "allowedUsers" | "allowAll">;
  locale: () => Locale;
  update: (a: { channel: string; ts: string; text: string; blocks: unknown[] }) => Promise<unknown>;
}

// When an allowlist user adds :x: to a bot-authored message, replace the entire body/blocks with the marker.
// If any gate (emoji, author, permission) fails, silently no-op. Swallow update failures (best-effort).
export async function redactOnReaction(args: RedactReactionArgs, deps: RedactDeps): Promise<void> {
  if (args.reaction !== REDACT_REACTION) return;
  // Only redact bot-authored messages — the bot can't edit user messages anyway (blocks pointless update attempts).
  if (!args.botUserId || args.itemUser !== args.botUserId) return;
  // fail-closed: only allowAll or users in the allowlist. If not permitted, silently ignore so the thread isn't cluttered.
  const { allowedUsers, allowAll } = deps.slackConfig();
  const permitted = allowAll || allowedUsers.includes(args.reactingUser ?? "");
  if (!permitted) return;

  const marker = redactedMarker(deps.locale());
  try {
    await deps.update({
      channel: args.channel,
      ts: args.ts,
      text: marker,
      blocks: [{ type: "section", text: { type: "mrkdwn", text: marker } }],
    });
  } catch (err) {
    // Already deleted, a permission issue, etc. — don't kill the adapter, just log what failed (existing best-effort convention).
    process.stderr.write(`[rookery] slack redact failed: ${String(err)}\n`);
  }
}
