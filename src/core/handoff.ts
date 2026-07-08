// Builds the context "seed" for a cross-provider fork (provider handoff): the source session/worker's
// transcript, flattened to text and byte-capped newest-first (same discipline as fleet-tools.ts
// formatTranscript), wrapped in a fence. The caller prepends this to the target's FIRST turn prompt so it
// becomes part of the target's turn-1 conversation ("baked in") — durable across resumes, unlike a
// system-prompt injection. See docs/2026-07-08-cross-provider-fork-design.md.

const DEFAULT_MAX_BYTES = 48 * 1024;

// One transcript event → a compact "role: text" line (best-effort; the goal is context, not perfect replay).
function lineOf(e: { type: string; payload: unknown }): string {
  const p = (e.payload ?? {}) as { kind?: string; role?: string; content?: string; text?: string; name?: string };
  if (p.role && typeof p.content === "string") return `${p.role}: ${p.content}`;
  if (p.kind === "thinking" && typeof p.text === "string") return `assistant (thinking): ${p.text}`;
  if (p.kind === "tool" || e.type.endsWith(".tool")) return `assistant (tool ${p.name ?? ""})`.trim();
  if (typeof p.text === "string") return p.text;
  return e.type;
}

export function buildHandoffSeed(
  events: Array<{ type: string; payload: unknown }>,
  sourceProvider: string,
  maxBytes: number = DEFAULT_MAX_BYTES,
): string {
  if (events.length === 0) return "";
  const lines = events.map(lineOf);
  const kept: string[] = [];
  let bytes = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const b = Buffer.byteLength(lines[i]!, "utf8") + 1; // +1 ≈ newline
    if (kept.length > 0 && bytes + b > maxBytes) break; // always keep at least the newest line
    kept.push(lines[i]!);
    bytes += b;
  }
  kept.reverse();
  const dropped = lines.length - kept.length;
  const body = (dropped > 0 ? `…(${dropped} older event${dropped === 1 ? "" : "s"} truncated)\n` : "") + kept.join("\n");
  return (
    `<prior-conversation from="${sourceProvider}">\n${body}\n</prior-conversation>\n` +
    `You are continuing the above conversation, which happened on a different assistant backend. ` +
    `Treat it as your own prior context. The user's next message follows.`
  );
}
