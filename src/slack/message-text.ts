// Extract as much human-readable text as possible from a Slack message (including Block Kit blocks / attachments / rich_text),
// and decide whether it is eligible for automation trigger evaluation. Pure functions — they don't depend on Bolt, so unit testing is easy.

export interface RawSlackMessage {
  subtype?: string;
  bot_id?: string;
  user?: string;
  text?: string;
  blocks?: unknown[];
  attachments?: unknown[];
}

// Is this message eligible for trigger evaluation?
// - Exclude our own bot's messages (prevents a feedback loop where replies/results left by automation re-trigger it).
// - Let other bot/integration messages (including the bot_message subtype) through → CI/monitoring/alert bots can trigger automations.
// - Exclude non-content subtypes such as edit/delete/join.
export function isTriggerableMessage(m: RawSlackMessage, selfBotId?: string): boolean {
  if (m.bot_id && selfBotId && m.bot_id === selfBotId) return false;
  if (m.subtype && m.subtype !== "bot_message") return false;
  return true;
}

// Extract all display text from the message and merge it into one chunk: text + blocks (Block Kit) + attachments (legacy).
// rich_text blocks usually just mirror m.text, so skip them when m.text is present (avoids duplication).
export function extractSlackText(m: RawSlackMessage): string {
  const out: string[] = [];
  if (typeof m.text === "string") out.push(m.text);
  const hasText = typeof m.text === "string" && m.text.trim().length > 0;
  for (const b of asArray(m.blocks)) {
    if (hasText && isRichText(b)) continue;
    collect(b, out);
  }
  for (const a of asArray(m.attachments)) collectAttachment(a, out);
  return dedupe(out);
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function isRichText(b: unknown): boolean {
  return b != null && typeof b === "object" && (b as { type?: unknown }).type === "rich_text";
}

// attachment: collect pretext/title/text/blocks, and if those are all empty fall back to fallback (the notification summary) only.
function collectAttachment(a: unknown, out: string[]): void {
  if (a == null || typeof a !== "object") return;
  const o = a as Record<string, unknown>;
  const before = out.length;
  for (const k of ["pretext", "title", "text"]) if (typeof o[k] === "string") out.push(o[k] as string);
  for (const b of asArray(o.blocks)) collect(b, out);
  if (out.length === before && typeof o.fallback === "string") out.push(o.fallback as string);
}

// Recursively collect Block Kit blocks/elements. text may be a string (mrkdwn/plain · rich_text run) or a {text} object (section/header).
function collect(node: unknown, out: string[]): void {
  if (node == null) return;
  if (Array.isArray(node)) { for (const x of node) collect(x, out); return; }
  if (typeof node !== "object") return;
  const o = node as Record<string, unknown>;
  if (typeof o.text === "string") out.push(o.text);
  else if (o.text && typeof o.text === "object") collect(o.text, out);
  if (o.type === "emoji" && typeof o.name === "string") out.push(`:${o.name as string}:`);
  if (o.type === "link" && typeof o.url === "string" && typeof o.text !== "string") out.push(o.url as string);
  for (const k of ["elements", "fields", "blocks"]) if (o[k]) collect(o[k], out);
}

// Trim lines + drop blank/duplicate lines (preserving order) — absorbs the common case where fallback duplicates the blocks content.
function dedupe(lines: string[]): string {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const raw of lines) {
    const s = raw.trim();
    if (s && !seen.has(s)) { seen.add(s); kept.push(s); }
  }
  return kept.join("\n").trim();
}
