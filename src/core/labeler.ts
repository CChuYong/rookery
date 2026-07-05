import type { QueryFn } from "./claude-backend.js";
import { extractText } from "./sdk-extract.js";

// Auto-generate worker labels: summarize a task into a single short label line using a cheap model (Haiku).
// best-effort — on failure/timeout/empty response, return null so the caller keeps its placeholder.
export const LABEL_MODEL = "claude-haiku-4-5";
const LABEL_TIMEOUT_MS = 15000;
const LABEL_SYSTEM =
  "You write ultra-short labels for coding tasks. Reply with ONLY a 2-6 word label " +
  "summarizing the task (imperative, e.g. 'Add rate limiting to checkout'). " +
  "No quotes, no trailing punctuation, no preamble, no explanation.";

// Clean up the model response into a label: first line only, strip wrapping quotes/trailing punctuation, cap length.
function cleanLabel(raw: string): string {
  const first = (raw.trim().split("\n")[0] ?? "").trim();
  return first
    .replace(/^["'`]+|["'`]+$/g, "") // wrapping quotes
    .replace(/[.\s]+$/g, "") // trailing periods/whitespace
    .slice(0, 60)
    .trim();
}

export function makeLabeler(queryFn: QueryFn, model: string = LABEL_MODEL): (task: string) => Promise<string | null> {
  return async (task: string): Promise<string | null> => {
    const trimmed = task.trim();
    if (!trimmed) return null;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), LABEL_TIMEOUT_MS);
    try {
      const q = queryFn({
        // string prompt = single-shot turn (self-terminating). Haiku doesn't support effort, so we don't send it.
        prompt: `Task:\n${trimmed.slice(0, 2000)}\n\nLabel:`,
        options: {
          model,
          systemPrompt: LABEL_SYSTEM,
          allowedTools: [], // label generation is pure text — no tools needed
          permissionMode: "bypassPermissions",
          abortController: abort,
        },
      });
      let text = "";
      for await (const msg of q) {
        if ((msg as { type?: string }).type === "assistant") text += extractText(msg);
      }
      return cleanLabel(text) || null;
    } catch {
      return null; // best-effort: caller keeps the placeholder
    } finally {
      clearTimeout(timer);
    }
  };
}
