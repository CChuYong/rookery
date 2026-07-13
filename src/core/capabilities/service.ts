import type { SlashCommandInfo } from "../agent-backend.js";
import { claudeCommandCapabilities, rookeryCapabilities } from "./builtins.js";
import type {
  CapabilityContribution,
  CapabilityDiagnostic,
  CapabilityEntry,
  CapabilitySnapshot,
  CapabilityTarget,
} from "./types.js";
import { sortCapabilityDiagnostics, sortCapabilityEntries } from "./types.js";

export interface CapabilitySessionRecord {
  id: string;
  cwd: string;
  label: string | null;
  provider: string;
}

export interface CapabilityWorkerRecord {
  id: string;
  worktreePath: string | null;
  repoPath: string;
  label: string;
  provider: string;
}

export interface ClaudeCommandDiscovery {
  commands: SlashCommandInfo[];
  error?: string;
}

export interface CapabilityServiceDeps {
  getSession(id: string): CapabilitySessionRecord | undefined;
  getWorker(id: string): CapabilityWorkerRecord | undefined;
  listClaudeCommands(input: { target: CapabilityTarget; cwd: string }): Promise<ClaudeCommandDiscovery>;
  listCodexCapabilities(input: { target: CapabilityTarget; cwd: string; env?: NodeJS.ProcessEnv }): Promise<CapabilityContribution>;
  codexEnvForTarget?(target: CapabilityTarget): NodeJS.ProcessEnv | undefined;
  now?: () => Date;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function providerFailure(provider: "claude" | "codex", error: unknown): CapabilityDiagnostic {
  return provider === "claude"
    ? {
        id: "claude.commands.discovery",
        source: "Claude supported commands",
        severity: "warning",
        message: errorMessage(error),
      }
    : {
        id: "codex.inventory.discovery",
        source: "Codex app-server",
        severity: "warning",
        message: errorMessage(error),
      };
}

function providerOf(value: string): "claude" | "codex" {
  if (value === "claude" || value === "codex") return value;
  throw new Error(`unsupported capability provider: ${value}`);
}

function deduplicateEntries(entries: CapabilityEntry[]): CapabilityEntry[] {
  const byId = new Map<string, CapabilityEntry>();
  for (const entry of sortCapabilityEntries(entries)) {
    if (!byId.has(entry.id)) byId.set(entry.id, entry);
  }
  return sortCapabilityEntries([...byId.values()]);
}

export class CapabilityService {
  private readonly now: () => Date;

  constructor(private readonly deps: CapabilityServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async snapshot(target: CapabilityTarget): Promise<CapabilitySnapshot> {
    const resolved = this.resolveTarget(target);
    const rookery = rookeryCapabilities({ targetKind: target.kind });
    let providerContribution: CapabilityContribution;

    if (resolved.provider === "claude") {
      try {
        const discovery = await this.deps.listClaudeCommands({ target, cwd: resolved.cwd });
        providerContribution = claudeCommandCapabilities(discovery.commands, discovery.error, target.kind);
      } catch (error) {
        providerContribution = { entries: [], diagnostics: [providerFailure("claude", error)] };
      }
    } else {
      try {
        const env = this.deps.codexEnvForTarget?.(target);
        providerContribution = await this.deps.listCodexCapabilities({ target, cwd: resolved.cwd, ...(env ? { env } : {}) });
      } catch (error) {
        providerContribution = { entries: [], diagnostics: [providerFailure("codex", error)] };
      }
    }

    return {
      target: { ...target, ...resolved },
      generatedAt: this.now().toISOString(),
      entries: deduplicateEntries([...rookery.entries, ...providerContribution.entries]),
      diagnostics: sortCapabilityDiagnostics([...rookery.diagnostics, ...providerContribution.diagnostics]),
    };
  }

  private resolveTarget(target: CapabilityTarget): { label: string; provider: "claude" | "codex"; cwd: string } {
    if (target.kind === "session") {
      const session = this.deps.getSession(target.id);
      if (!session) throw new Error(`unknown capability target: session:${target.id}`);
      return {
        label: session.label?.trim() || session.cwd,
        provider: providerOf(session.provider),
        cwd: session.cwd,
      };
    }

    const worker = this.deps.getWorker(target.id);
    if (!worker) throw new Error(`unknown capability target: worker:${target.id}`);
    return {
      label: worker.label,
      provider: providerOf(worker.provider),
      cwd: worker.worktreePath ?? worker.repoPath,
    };
  }
}
