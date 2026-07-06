import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance, SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Repositories } from "../persistence/repositories.js";

export const MEMORY_SERVER_NAME = "memory";
export const MEMORY_TOOL_NAMES = ["mcp__memory__remember", "mcp__memory__recall"] as const;

export function rememberImpl(
  repos: Repositories,
  args: { content: string; tags?: string },
): { ok: true; id: number } {
  const row = repos.addMemory({ content: args.content, tags: args.tags ?? "" });
  return { ok: true, id: row.id };
}

export function recallImpl(
  repos: Repositories,
  args: { query: string; limit?: number },
): { matches: Array<{ content: string; tags: string }> } {
  const rows = repos.searchMemories(args.query, args.limit ?? 5);
  return { matches: rows.map((r) => ({ content: r.content, tags: r.tags })) };
}

// Raw tool defs (extracted so they can travel the provider-neutral port — see agent-backend.ts's
// ProviderToolDef / MasterTurnOptions.toolDefs). Claude wraps these with createSdkMcpServer below;
// the Codex adapter registers the same objects on the daemon MCP bridge (src/daemon/mcp-bridge.ts).
export function memoryToolDefs(repos: Repositories): SdkMcpToolDefinition<any>[] {
  const remember = tool(
    "remember",
    "Persist an important fact to long-term memory so it can be recalled in future turns or sessions.",
    {
      content: z.string().describe("The fact to remember, as a self-contained sentence."),
      tags: z.string().optional().describe("Comma-separated tags for later retrieval."),
    },
    async (args) => {
      try {
        const { id } = rememberImpl(repos, args);
        return { content: [{ type: "text", text: `Remembered (#${id}).` }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Failed to remember: ${String(err)}` }],
          isError: true,
        };
      }
    },
    { annotations: { readOnlyHint: false } },
  );

  const recall = tool(
    "recall",
    "Search long-term memory for facts matching a keyword query.",
    {
      query: z.string().describe("Keyword(s) to search remembered facts by."),
      limit: z.number().optional().describe("Max number of matches (default 5)."),
    },
    async (args) => {
      try {
        const { matches } = recallImpl(repos, args);
        const text =
          matches.length === 0
            ? "No matching memories."
            : matches.map((m, i) => `${i + 1}. ${m.content}${m.tags ? ` [${m.tags}]` : ""}`).join("\n");
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Failed to recall: ${String(err)}` }],
          isError: true,
        };
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  return [remember, recall];
}

export function createMemoryToolsServer(repos: Repositories): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({ name: MEMORY_SERVER_NAME, version: "0.0.1", tools: memoryToolDefs(repos) });
}
