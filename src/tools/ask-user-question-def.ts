import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// Bridge tool def for AskUserQuestion (P2 — docs/2026-07-06-p2-codex-master.md §The MCP bridge,
// last bullet). Claude masters get this capability NATIVELY (the harness's own AskUserQuestion tool
// + canUseTool — see master-agent.ts's baseAllowed / claude-backend.ts's group drop). Codex masters
// have no native equivalent, so this def travels the neutral toolDefs port and is exposed to them as
// an ordinary MCP tool; the ClaudeBackend adapter strips this group before wrapping so Claude never
// sees a duplicate AskUserQuestion tool alongside its native one.
//
// The input shape mirrors what the two actual interaction channels parse (NOT the Claude harness's
// own strict native schema, which has tuple-length constraints (1-4 questions/2-4 options) and extra
// fields like `preview` irrelevant here): see src/core/interaction-registry.ts's `InteractionQuestion`
// and src/slack/interaction.ts's `Question` — both read `{ question, header?, options: [{label,
// description?}], multiSelect? }`.
const questionSchema = z.object({
  question: z.string().describe("The complete question to ask the human, ending with a question mark."),
  header: z.string().optional().describe("A short label/header shown above the question."),
  options: z
    .array(
      z.object({
        label: z.string().describe("The option's display label, shown to the human."),
        description: z.string().optional().describe("Optional detail explaining this option."),
      }),
    )
    .describe("The selectable options for this question."),
  multiSelect: z.boolean().optional().describe("Whether the human may select more than one option."),
});

// Result of the injected ask channel. Structurally the SDK's PermissionResult (behavior "allow"
// carries updatedInput; "deny" carries message) — declared locally (not imported) so this stays a
// pure structural contract between this def and whatever closure the caller (master-agent.ts) builds
// from the opaque canUseTool it holds.
export interface AskChannelResult {
  behavior: string;
  updatedInput?: unknown;
  message?: string;
}

// One MCP tool def named exactly "AskUserQuestion" — the name matters: both interaction-registry.ts's
// `request()` and slack/interaction.ts's `prompt()` gate their "ask" (vs plain "approve") card
// rendering on `toolName === "AskUserQuestion"`, so the bridge must present the SAME name for a codex
// tool call to be recognized and rendered as a structured-question card rather than a generic approval.
export function askUserQuestionDef(ask: (input: unknown) => Promise<AskChannelResult>): SdkMcpToolDefinition<any> {
  return tool(
    "AskUserQuestion",
    "Ask the human one or more structured multiple-choice questions and receive their answers. " +
      "Use this when you need the human's input or a decision before proceeding.",
    { questions: z.array(questionSchema).describe("The questions to ask, in order.") },
    async (args) => {
      const res = await ask(args);
      if (res.behavior === "allow") {
        // interaction-registry/slack both resolve with `updatedInput: { questions, answers }` — surface
        // just the answers as the tool's output; fall back to the whole updatedInput (or {}) if some
        // other channel ever resolves without the nested `answers` shape.
        const answers = (res.updatedInput as { answers?: unknown } | undefined)?.answers ?? res.updatedInput ?? {};
        return { content: [{ type: "text", text: JSON.stringify(answers) }] };
      }
      return { content: [{ type: "text", text: `question denied/unanswered: ${res.message ?? ""}` }], isError: true };
    },
    { annotations: { readOnlyHint: true } },
  );
}
