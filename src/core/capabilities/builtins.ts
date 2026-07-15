import type { SlashCommandInfo } from "../agent-backend.js";
import type { CapabilityContribution, CapabilityEntry, CapabilityScope } from "./types.js";
import { sortCapabilityEntries } from "./types.js";

const ROOKERY_COMMANDS: CapabilityEntry[] = [
  {
    id: "rookery.command.btw",
    kind: "command",
    name: "/btw",
    description: "Ask a side question without interrupting the active conversation.",
    detail: "<question>",
    provider: "rookery",
    source: "Rookery desktop",
    scope: "builtin",
    state: "applied",
    evidence: "declared",
  },
  {
    id: "rookery.command.side",
    kind: "command",
    name: "/side",
    description: "Ask a side question without interrupting the active conversation.",
    detail: "<question>",
    provider: "rookery",
    source: "Rookery desktop",
    scope: "builtin",
    state: "applied",
    evidence: "declared",
  },
];

const MASTER_TOOL_GROUPS: CapabilityEntry[] = [
  {
    id: "rookery.tool.memory",
    kind: "tool",
    name: "Memory tools",
    description: "Persist and recall long-term memory across sessions.",
    detail: "remember, recall",
    provider: "rookery",
    source: "Rookery master tools",
    scope: "session",
    state: "applied",
    evidence: "declared",
  },
  {
    id: "rookery.tool.repos",
    kind: "tool",
    name: "Repository tools",
    description: "Register, inspect, update, and remove repositories in the Rookery pool.",
    detail: "register_repo, list_repos, update_repo, remove_repo",
    provider: "rookery",
    source: "Rookery master tools",
    scope: "session",
    state: "applied",
    evidence: "declared",
  },
  {
    id: "rookery.tool.fleet",
    kind: "tool",
    name: "Fleet tools",
    description: "Spawn, observe, steer, stop, and discard Rookery workers.",
    detail: "spawn_worker, send_worker, interrupt_worker, list_workers, get_worker_status, view_worker_transcript, view_worker_diff, stop_worker, discard_worker",
    provider: "rookery",
    source: "Rookery master tools",
    scope: "session",
    state: "applied",
    evidence: "declared",
  },
  {
    id: "rookery.tool.schedule",
    kind: "tool",
    name: "Schedule tools",
    description: "Schedule, list, and cancel one-shot wakeups for the current session.",
    detail: "schedule_wakeup, schedule_list, schedule_cancel",
    provider: "rookery",
    source: "Rookery master tools",
    scope: "session",
    state: "applied",
    evidence: "declared",
  },
];

export function rookeryCapabilities(input: { targetKind: "session" | "worker" }): CapabilityContribution {
  const entries = input.targetKind === "session" ? [...ROOKERY_COMMANDS, ...MASTER_TOOL_GROUPS] : [...ROOKERY_COMMANDS];
  return { entries: sortCapabilityEntries(entries), diagnostics: [] };
}

function normalizedCommandName(name: string): string {
  return name.trim().replace(/^\/+/, "").toLowerCase();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function claudeCommandCapabilities(
  commands: SlashCommandInfo[],
  discoveryError?: unknown,
  targetKind: "session" | "worker" = "session",
): CapabilityContribution {
  const scope: CapabilityScope = targetKind;
  const entries = commands.flatMap((command): CapabilityEntry[] => {
    const normalized = normalizedCommandName(command.name);
    if (!normalized) return [];
    const detail = [
      command.argumentHint?.trim(),
      command.aliases?.length ? `aliases: ${command.aliases.map((alias) => `/${normalizedCommandName(alias)}`).join(", ")}` : undefined,
    ].filter(Boolean).join(" · ");
    return [{
      id: `claude.command.${normalized}`,
      kind: "command",
      name: `/${normalized}`,
      description: command.description,
      ...(detail ? { detail } : {}),
      provider: "claude",
      source: "Claude supported commands",
      scope,
      state: "applied",
      evidence: "runtime",
    }];
  });

  return {
    entries: sortCapabilityEntries(entries),
    diagnostics: discoveryError === undefined ? [] : [{
      id: "claude.commands.discovery",
      source: "Claude supported commands",
      severity: "warning",
      message: errorMessage(discoveryError),
    }],
  };
}
