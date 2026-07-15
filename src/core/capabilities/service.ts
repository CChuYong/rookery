import type { SlashCommandInfo } from "../agent-backend.js";
import { canonicalPath, longestContainingRepo } from "../repo-path.js";
import { claudeCommandCapabilities, rookeryCapabilities } from "./builtins.js";
import type { CapabilityRegistry } from "./registry.js";
import type { CapabilityResolver, ResolvedCapabilityTarget } from "./resolver.js";
import type { ResolvedAgentCapabilities } from "./types.js";
import type {
  CapabilityRuntimeInspector,
  CapabilityRuntimeTarget,
  CapabilityRuntimeView,
} from "./runtime-state.js";
import type {
  CapabilityBinding,
  CapabilityBindingInput,
  CapabilityContribution,
  CapabilityDiagnostic,
  CapabilityEntry,
  CapabilityLibraryEntry,
  CapabilityLibrarySnapshot,
  CapabilityOrigin,
  CapabilitySecretStatus,
  CapabilitySnapshot,
  CapabilityTarget,
} from "./types.js";
import { sortCapabilityDiagnostics, sortCapabilityEntries } from "./types.js";

export interface CapabilitySessionRecord {
  id: string;
  cwd: string;
  label: string | null;
  provider: string;
  origin?: string | null;
  externalKey?: string | null;
}

export interface CapabilityWorkerRecord {
  id: string;
  worktreePath: string | null;
  repoPath: string;
  label: string;
  provider: string;
  homeSessionId?: string;
}

export interface CapabilityRepoRecord {
  id: string;
  path: string;
}

export interface ClaudeCommandDiscovery {
  commands: SlashCommandInfo[];
  error?: string;
}

export interface CapabilityServiceDeps {
  getSession(id: string): CapabilitySessionRecord | undefined;
  getWorker(id: string): CapabilityWorkerRecord | undefined;
  listRepos?(): CapabilityRepoRecord[];
  listClaudeCommands(input: { target: CapabilityTarget; cwd: string }): Promise<ClaudeCommandDiscovery>;
  listCodexCapabilities(input: { target: CapabilityTarget; cwd: string; env?: NodeJS.ProcessEnv }): Promise<CapabilityContribution>;
  codexEnvForTarget?(target: CapabilityTarget): NodeJS.ProcessEnv | undefined;
  registry?: CapabilityRegistry;
  resolver?: CapabilityResolver;
  runtimeState?: CapabilityRuntimeInspector;
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

function originOf(origin: string | null | undefined, externalKey: string | null | undefined): CapabilityOrigin {
  if (origin === "ui" || origin === "slack" || origin === "automation" || origin === "external") return origin;
  if (externalKey?.startsWith("slack:")) return "slack";
  if (externalKey?.startsWith("automation:")) return "automation";
  if (externalKey?.startsWith("external:")) return "external";
  return "ui";
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

    const desired = this.deps.resolver?.resolve(resolved.desired);
    const runtimeTarget = this.runtimeTarget(resolved.desired);
    const runtime = desired && this.deps.runtimeState
      ? this.deps.runtimeState.inspect(runtimeTarget, desired.revision, desired.blocked)
      : undefined;
    const desiredEntries = this.projectRuntimeEntries(desired?.entries ?? [], runtime);
    const runtimeDiagnostics: CapabilityDiagnostic[] = runtime?.state === "error" && runtime.error
      ? [{
          id: `capabilities.runtime.${runtimeTarget.targetKind}.${runtimeTarget.targetId}`,
          source: "Rookery capability runtime",
          severity: "error",
          message: runtime.error,
        }]
      : [];
    return {
      target: { ...target, label: resolved.label, provider: resolved.provider, cwd: resolved.cwd },
      generatedAt: this.now().toISOString(),
      ...(desired ? { desiredRevision: desired.revision, desiredBlocked: desired.blocked } : {}),
      ...(runtime ? { appliedRevision: runtime.appliedRevision } : {}),
      entries: deduplicateEntries([...desiredEntries, ...rookery.entries, ...providerContribution.entries]),
      diagnostics: sortCapabilityDiagnostics([...(desired?.diagnostics ?? []), ...runtimeDiagnostics, ...rookery.diagnostics, ...providerContribution.diagnostics]),
    };
  }

  // Internal composition-root port. The returned value contains only trusted public specs and secret
  // references; actual values remain behind CapabilityRuntime's daemon-only lookup.
  resolveManaged(target: CapabilityTarget): ResolvedAgentCapabilities {
    if (!this.deps.resolver) throw new Error("capability resolver unavailable");
    return this.deps.resolver.resolve(this.resolveTarget(target).desired).runtime;
  }

  library(): CapabilityLibrarySnapshot {
    if (!this.deps.registry) throw new Error("capability registry unavailable");
    return this.deps.registry.list();
  }

  addPack(sourcePath: string): CapabilityLibraryEntry {
    if (!this.deps.registry) throw new Error("capability registry unavailable");
    return this.deps.registry.add(sourcePath);
  }

  removePack(instanceId: string): void {
    if (!this.deps.registry) throw new Error("capability registry unavailable");
    this.deps.registry.remove(instanceId);
  }

  setBinding(id: string, input: CapabilityBindingInput): CapabilityBinding {
    if (!this.deps.registry) throw new Error("capability registry unavailable");
    return this.deps.registry.setBinding(id, input);
  }

  deleteBinding(id: string): void {
    if (!this.deps.registry) throw new Error("capability registry unavailable");
    this.deps.registry.deleteBinding(id);
  }

  setTrust(instanceId: string, digest: string, trusted: boolean): CapabilityLibraryEntry {
    if (!this.deps.registry) throw new Error("capability registry unavailable");
    return this.deps.registry.setTrust(instanceId, digest, trusted);
  }

  setSecret(instanceId: string, key: string, value: string): CapabilitySecretStatus {
    if (!this.deps.registry) throw new Error("capability registry unavailable");
    return this.deps.registry.setSecret(instanceId, key, value);
  }

  deleteSecret(instanceId: string, key: string): CapabilitySecretStatus {
    if (!this.deps.registry) throw new Error("capability registry unavailable");
    return this.deps.registry.deleteSecret(instanceId, key);
  }

  refresh(instanceId?: string): CapabilityLibrarySnapshot {
    if (!this.deps.registry) throw new Error("capability registry unavailable");
    return this.deps.registry.refresh(instanceId);
  }

  private runtimeTarget(target: ResolvedCapabilityTarget): CapabilityRuntimeTarget {
    if (target.kind === "master") {
      return { targetKind: "master", targetId: target.id, sessionId: target.homeSessionId ?? target.id };
    }
    return { targetKind: "worker", targetId: target.id, sessionId: target.homeSessionId ?? target.id };
  }

  private projectRuntimeEntries(
    entries: CapabilityEntry[],
    runtime: CapabilityRuntimeView | undefined,
  ): CapabilityEntry[] {
    if (!runtime) return entries;
    return entries.map((entry) => {
      // Resolver-specific blocking/unavailability/suppression is more precise than revision drift and
      // must survive projection. Runtime state only replaces entries that were launchable (`desired`).
      if (!entry.managed || entry.state !== "desired") return entry;
      if (runtime.state === "current") return { ...entry, state: "applied", evidence: "runtime" };
      if (runtime.state === "pending-next-turn" || runtime.state === "pending-reload") {
        return { ...entry, state: runtime.state };
      }
      if (runtime.state === "blocked" || runtime.state === "error") return { ...entry, state: runtime.state };
      return entry;
    });
  }

  private resolveTarget(target: CapabilityTarget): {
    label: string;
    provider: "claude" | "codex";
    cwd: string;
    desired: ResolvedCapabilityTarget;
  } {
    if (target.kind === "session") {
      const session = this.deps.getSession(target.id);
      if (!session) throw new Error(`unknown capability target: session:${target.id}`);
      const provider = providerOf(session.provider);
      const repo = longestContainingRepo(session.cwd, this.deps.listRepos?.() ?? []);
      return {
        label: session.label?.trim() || session.cwd,
        provider,
        cwd: session.cwd,
        desired: {
          kind: "master",
          id: session.id,
          provider,
          origin: originOf(session.origin, session.externalKey),
          cwd: session.cwd,
          ...(repo ? { repoId: repo.id } : {}),
          homeSessionId: session.id,
        },
      };
    }

    const worker = this.deps.getWorker(target.id);
    if (!worker) throw new Error(`unknown capability target: worker:${target.id}`);
    const provider = providerOf(worker.provider);
    const homeSession = worker.homeSessionId ? this.deps.getSession(worker.homeSessionId) : undefined;
    const repo = (this.deps.listRepos?.() ?? []).find((candidate) =>
      canonicalPath(candidate.path) === canonicalPath(worker.repoPath));
    const cwd = worker.worktreePath ?? worker.repoPath;
    return {
      label: worker.label,
      provider,
      cwd,
      desired: {
        kind: "worker",
        id: worker.id,
        provider,
        origin: originOf(homeSession?.origin, homeSession?.externalKey),
        cwd,
        ...(repo ? { repoId: repo.id } : {}),
        ...(worker.homeSessionId ? { homeSessionId: worker.homeSessionId } : {}),
      },
    };
  }
}
