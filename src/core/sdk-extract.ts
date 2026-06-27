// Pure extractor that pulls text, tool calls, and tool results from SDK messages (assistant/user).
// Shared by the master (master-agent) and the worker (worker) — keeping the decode logic in one place so the two stream loops don't diverge.
// (Previously worker.ts exported it and master imported it, creating a master→worker dependency edge.)

// assistant.message.content is a block array → concatenate only the text blocks.
export function extractText(message: unknown): string {
  const content = (message as { message?: { content?: unknown } }).message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: "text"; text: string } =>
        typeof b === "object" && b !== null && (b as { type?: string }).type === "text",
      )
      .map((b) => b.text)
      .join("");
  }
  return "";
}

export function extractToolUses(message: unknown): Array<{ id: string; name: string; input: unknown }> {
  const content = (message as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter(
      (b): b is { type: "tool_use"; id: string; name: string; input?: unknown } =>
        typeof b === "object" && b !== null && (b as { type?: string }).type === "tool_use",
    )
    .map((b) => ({ id: b.id, name: b.name, input: b.input }));
}

export function extractToolResults(message: unknown): Array<{ toolUseId: string; isError: boolean; content: string }> {
  const content = (message as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter(
      (b): b is { type: "tool_result"; tool_use_id: string; is_error?: boolean; content?: unknown } =>
        typeof b === "object" && b !== null && (b as { type?: string }).type === "tool_result",
    )
    .map((b) => ({ toolUseId: b.tool_use_id, isError: Boolean(b.is_error), content: blockText(b.content) }));
}

// tool_result.content may be a string or an array of {type:text,text} blocks → coerce to text.
function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === "object" && b !== null && (b as { type?: string }).type === "text" ? String((b as { text?: string }).text ?? "") : ""))
      .join("");
  }
  return "";
}
