import { randomUUID } from "node:crypto";
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Repositories } from "../persistence/repositories.js";
import { isSafeGitRef } from "../core/git-ref.js";
import { repoPathError } from "../core/repo-path.js";

export const REPO_SERVER_NAME = "repos";
export const REPO_TOOL_NAMES = [
  "mcp__repos__register_repo",
  "mcp__repos__list_repos",
  "mcp__repos__update_repo",
  "mcp__repos__remove_repo",
] as const;

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}
function errorText(t: string) {
  return { content: [{ type: "text" as const, text: t }], isError: true };
}

export function createRepoToolsServer(repos: Repositories, idgen: () => string = () => randomUUID()): McpSdkServerConfigWithInstance {
  const register = tool(
    "register_repo",
    "Register a git repository into the pool so workers can be spawned against it. Provide a short domain description for routing.",
    {
      name: z.string().describe("Short unique name, e.g. 'app-api'."),
      path: z.string().describe("Absolute local path to the cloned repo."),
      description: z.string().describe("What this repo is for (domain)."),
      base: z.string().optional().describe("Default base branch (defaults to repo HEAD)."),
    },
    async (args) => {
      if (args.base !== undefined && !isSafeGitRef(args.base)) {
        return errorText(`invalid base ref '${args.base}'. Use a plain branch name, tag, or commit SHA (no spaces or leading '-').`);
      }
      const perr = repoPathError(args.path);
      if (perr) return errorText(`invalid repo path: ${perr}`);
      try {
        repos.createRepo({ id: idgen(), name: args.name, path: args.path, description: args.description, base: args.base });
        return text(`Registered repo '${args.name}' (${args.path}).`);
      } catch (err) {
        return errorText(`register failed: ${String(err)}`);
      }
    },
  );

  const list = tool(
    "list_repos",
    "List registered repos with their domain descriptions.",
    {},
    async () => {
      const rs = repos.listRepos();
      const body = rs.length === 0 ? "No repos registered." : rs.map((r) => `${r.name}: ${r.description} (${r.path})`).join("\n");
      return text(body);
    },
    { annotations: { readOnlyHint: true } },
  );

  const update = tool(
    "update_repo",
    "Update a registered repo's description or default base.",
    { name: z.string(), description: z.string().optional(), base: z.string().optional() },
    async (args) => {
      if (args.base !== undefined && !isSafeGitRef(args.base)) {
        return errorText(`invalid base ref '${args.base}'. Use a plain branch name, tag, or commit SHA (no spaces or leading '-').`);
      }
      try {
        if (!repos.getRepoByName(args.name)) return errorText(`unknown repo: ${args.name}`);
        repos.updateRepo(args.name, { description: args.description, base: args.base });
        return text(`Updated '${args.name}'.`);
      } catch (err) {
        return errorText(`update failed: ${String(err)}`);
      }
    },
  );

  const remove = tool(
    "remove_repo",
    "Remove a repo from the pool.",
    { name: z.string() },
    async (args) => {
      if (!repos.getRepoByName(args.name)) return errorText(`unknown repo: ${args.name}`); // don't respond with "success" for a name that doesn't exist (symmetric with update_repo)
      repos.removeRepo(args.name);
      return text(`Removed '${args.name}'.`);
    },
  );

  return createSdkMcpServer({ name: REPO_SERVER_NAME, version: "0.0.1", tools: [register, list, update, remove] });
}
