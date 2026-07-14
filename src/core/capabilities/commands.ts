import type {
  CapabilityEntry,
  CapabilityKind,
  CapabilitySnapshot,
} from "./types.js";
import { sortCapabilityEntries } from "./types.js";

export type CommandAction =
  | { type: "insert-prompt"; text: string }
  | { type: "open-capability-center"; tab?: "effective" | "assignments" | "library"; kind?: CapabilityKind }
  | { type: "open-panel"; panel: "side" | "btw" }
  | { type: "daemon-request"; method: string }
  | { type: "provider-request"; provider: "claude" | "codex"; method: string };

export interface CommandCandidate {
  id: string;
  name: string;
  description: string;
  argumentHint?: string;
  aliases?: string[];
  action: CommandAction;
}

interface RookeryCommandDefinition {
  id: string;
  name: string;
  description: string;
  argumentHint?: string;
  invocationName: string;
  action: CommandAction;
}

const ROOKERY_COMMANDS: readonly RookeryCommandDefinition[] = [
  {
    id: "rookery.command.btw",
    name: "btw",
    description: "Ask a side question without interrupting the active conversation.",
    argumentHint: "<question>",
    invocationName: "open-panel:btw",
    action: { type: "open-panel", panel: "btw" },
  },
  {
    id: "rookery.command.capabilities",
    name: "capabilities",
    description: "Open Capability Center for the current conversation.",
    invocationName: "open-capability-center",
    action: { type: "open-capability-center", tab: "effective" },
  },
  {
    id: "rookery.command.hooks",
    name: "hooks",
    description: "Open the hooks view in Capability Center.",
    invocationName: "open-capability-center:hook",
    action: { type: "open-capability-center", tab: "effective", kind: "hook" },
  },
  {
    id: "rookery.command.mcp",
    name: "mcp",
    description: "Open the MCP view in Capability Center.",
    invocationName: "open-capability-center:mcp",
    action: { type: "open-capability-center", tab: "effective", kind: "mcp" },
  },
  {
    id: "rookery.command.side",
    name: "side",
    description: "Ask a side question without interrupting the active conversation.",
    argumentHint: "<question>",
    invocationName: "open-panel:side",
    action: { type: "open-panel", panel: "side" },
  },
  {
    id: "rookery.command.skills",
    name: "skills",
    description: "Open the skills view in Capability Center.",
    invocationName: "open-capability-center:skill",
    action: { type: "open-capability-center", tab: "effective", kind: "skill" },
  },
] as const;

function normalizeName(name: string): string {
  return name.trim().replace(/^[/$]+/, "").toLowerCase();
}

function entryCandidate(entry: CapabilityEntry): CommandCandidate | null {
  if ((entry.kind !== "command" && entry.kind !== "skill") || entry.invocation?.type !== "prompt") return null;
  const text = entry.invocation.name?.trim();
  const name = normalizeName(entry.name);
  if (!text || !name) return null;
  const aliases = entry.command?.aliases
    ?.map(normalizeName)
    .filter((alias, index, all) => alias && alias !== name && all.indexOf(alias) === index);
  return {
    id: entry.id,
    name,
    description: entry.description ?? "",
    ...(entry.command?.argumentHint ? { argumentHint: entry.command.argumentHint } : {}),
    ...(aliases?.length ? { aliases } : {}),
    action: { type: "insert-prompt", text },
  };
}

export function rookeryCommandEntries(_targetKind: "session" | "worker"): CapabilityEntry[] {
  return sortCapabilityEntries(ROOKERY_COMMANDS.map((definition) => ({
    id: definition.id,
    kind: "command" as const,
    name: `/${definition.name}`,
    description: definition.description,
    ...(definition.argumentHint ? { detail: definition.argumentHint, command: { argumentHint: definition.argumentHint } } : {}),
    provider: "rookery" as const,
    source: "Rookery desktop",
    scope: "builtin" as const,
    state: "applied" as const,
    evidence: "declared" as const,
    invocation: { type: "client-action" as const, name: definition.invocationName },
  })));
}

export function commandCandidates(snapshot: CapabilitySnapshot): CommandCandidate[] {
  const candidates: CommandCandidate[] = ROOKERY_COMMANDS.map((definition) => ({
    id: definition.id,
    name: definition.name,
    description: definition.description,
    ...(definition.argumentHint ? { argumentHint: definition.argumentHint } : {}),
    action: definition.action,
  }));
  const occupied = new Set(candidates.map((candidate) => normalizeName(candidate.name)));
  for (const candidate of promptCommandCandidates(snapshot.entries)) {
    const key = normalizeName(candidate.name);
    if (occupied.has(key)) continue;
    occupied.add(key);
    candidates.push(candidate);
  }
  return candidates.sort((a, b) => normalizeName(a.name).localeCompare(normalizeName(b.name)) || a.id.localeCompare(b.id));
}

export function promptCommandCandidates(entries: CapabilityEntry[]): CommandCandidate[] {
  const candidates: CommandCandidate[] = [];
  const occupied = new Set<string>();
  const promptEntries = sortCapabilityEntries(entries)
    .filter((entry) => !ROOKERY_COMMANDS.some((definition) => definition.id === entry.id))
    .map((entry) => ({ entry, candidate: entryCandidate(entry) }))
    .filter((item): item is { entry: CapabilityEntry; candidate: CommandCandidate } => item.candidate !== null);

  for (const { entry, candidate } of promptEntries.filter((item) => !item.entry.managed)) {
    const key = normalizeName(candidate.name);
    if (occupied.has(key)) continue;
    occupied.add(key);
    candidates.push(candidate);
  }

  const managedCounts = new Map<string, number>();
  for (const { entry, candidate } of promptEntries) {
    if (!entry.managed) continue;
    const key = normalizeName(candidate.name);
    managedCounts.set(key, (managedCounts.get(key) ?? 0) + 1);
  }
  for (const { entry, candidate } of promptEntries) {
    if (!entry.managed) continue;
    const key = normalizeName(candidate.name);
    if (managedCounts.get(key) !== 1 || occupied.has(key)) continue;
    occupied.add(key);
    candidates.push(candidate);
  }

  return candidates.sort((a, b) => normalizeName(a.name).localeCompare(normalizeName(b.name)) || a.id.localeCompare(b.id));
}
