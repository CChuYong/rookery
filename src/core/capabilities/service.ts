import { randomUUID } from "node:crypto";
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
  CapabilityCatalogCreateResult,
  CapabilityContribution,
  CapabilityDiagnostic,
  CapabilityEntry,
  CapabilityLibraryEntry,
  CapabilityLibrarySnapshot,
  CapabilityLiveTarget,
  CapabilityMcpCreateInput,
  CapabilityMcpPackCreateInput,
  CapabilityMcpPackCreateResult,
  CapabilityOrigin,
  CapabilityPackManifest,
  CapabilityQuickBindingInput,
  CapabilityPreviewTarget,
  CapabilitySecretStatus,
  CapabilitySkillCreateInput,
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
  name?: string;
}

export interface ClaudeCommandDiscovery {
  commands: SlashCommandInfo[];
  error?: string;
}

export interface GeneratedCapabilityPackPort {
  create(manifest: CapabilityPackManifest): string;
  createSkill(manifest: CapabilityPackManifest, sourcePath: string): string;
  remove(sourcePath: string): void;
}

export interface CapabilityServiceDeps {
  getSession(id: string): CapabilitySessionRecord | undefined;
  getWorker(id: string): CapabilityWorkerRecord | undefined;
  listRepos?(): CapabilityRepoRecord[];
  listClaudeCommands(input: { target: CapabilityTarget; cwd: string }): Promise<ClaudeCommandDiscovery>;
  listCodexCapabilities(input: { target: CapabilityTarget; cwd: string; env?: NodeJS.ProcessEnv }): Promise<CapabilityContribution>;
  codexEnvForTarget?(target: CapabilityLiveTarget): NodeJS.ProcessEnv | undefined;
  registry?: CapabilityRegistry;
  generatedPacks?: GeneratedCapabilityPackPort;
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
    const builtinTargetKind = resolved.desired.kind === "master" ? "session" : "worker";
    const rookery = rookeryCapabilities({ targetKind: builtinTargetKind });
    let providerContribution: CapabilityContribution;

    if (resolved.preview && target.kind === "rookery") {
      providerContribution = { entries: [], diagnostics: [] };
    } else if (resolved.cwd === null) {
      throw new Error("capability provider inventory requires a target cwd");
    } else if (resolved.provider === "claude") {
      try {
        const discovery = await this.deps.listClaudeCommands({ target, cwd: resolved.cwd });
        providerContribution = claudeCommandCapabilities(discovery.commands, discovery.error, builtinTargetKind);
      } catch (error) {
        providerContribution = { entries: [], diagnostics: [providerFailure("claude", error)] };
      }
    } else {
      try {
        const env = !resolved.preview && this.deps.codexEnvForTarget
          ? this.deps.codexEnvForTarget(target as CapabilityLiveTarget)
          : undefined;
        providerContribution = await this.deps.listCodexCapabilities({ target, cwd: resolved.cwd, ...(env ? { env } : {}) });
      } catch (error) {
        providerContribution = { entries: [], diagnostics: [providerFailure("codex", error)] };
      }
    }

    const desired = this.deps.resolver?.resolve(resolved.desired);
    const runtimeTarget = resolved.preview ? undefined : this.runtimeTarget(resolved.desired);
    const runtime = desired && runtimeTarget && this.deps.runtimeState
      ? this.deps.runtimeState.inspect(runtimeTarget, desired.revision, desired.blocked)
      : undefined;
    const desiredEntries = resolved.preview
      ? this.projectPreviewEntries(desired?.entries ?? [])
      : this.projectRuntimeEntries(desired?.entries ?? [], runtime, resolved.desired);
    const runtimeDiagnostics: CapabilityDiagnostic[] = runtime?.state === "error" && runtime.error
      ? [{
          id: `capabilities.runtime.${runtimeTarget!.targetKind}.${runtimeTarget!.targetId}`,
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
      entries: deduplicateEntries(resolved.preview
        ? [
            ...desiredEntries,
            ...this.projectPreviewEntries(rookery.entries),
            ...this.projectPreviewEntries(providerContribution.entries),
          ]
        : [...desiredEntries, ...rookery.entries, ...providerContribution.entries]),
      diagnostics: sortCapabilityDiagnostics([...(desired?.diagnostics ?? []), ...runtimeDiagnostics, ...rookery.diagnostics, ...providerContribution.diagnostics]),
    };
  }

  // Internal composition-root port. The returned value contains only trusted public specs and secret
  // references; actual values remain behind CapabilityRuntime's daemon-only lookup.
  resolveManaged(target: CapabilityLiveTarget): ResolvedAgentCapabilities {
    if (!this.deps.resolver) throw new Error("capability resolver unavailable");
    return this.deps.resolver.resolve(this.resolveLiveTarget(target).desired).runtime;
  }

  library(): CapabilityLibrarySnapshot {
    if (!this.deps.registry) throw new Error("capability registry unavailable");
    return this.deps.registry.list();
  }

  addPack(sourcePath: string): CapabilityLibraryEntry {
    if (!this.deps.registry) throw new Error("capability registry unavailable");
    return this.deps.registry.add(sourcePath);
  }

  createMcpPack(input: CapabilityMcpPackCreateInput): CapabilityMcpPackCreateResult {
    const registry = this.deps.registry;
    const generatedPacks = this.deps.generatedPacks;
    if (!registry) throw new Error("capability registry unavailable");
    if (!generatedPacks) throw new Error("generated capability pack store unavailable");

    const manifest: CapabilityPackManifest = {
      schemaVersion: 1,
      id: input.id,
      displayName: input.displayName,
      version: input.version,
      description: input.description,
      mcpServers: input.mcpServers,
    };
    let sourcePath: string | undefined;
    let instanceId: string | undefined;
    try {
      sourcePath = generatedPacks.create(manifest);
      const added = registry.add(sourcePath, { sourceKind: "rookery-generated" });
      instanceId = added.instanceId;
      for (const [key, value] of Object.entries(input.secretValues ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
        registry.setSecret(instanceId, key, value);
      }
      const binding = registry.setBinding(randomUUID(), {
        packInstanceId: instanceId,
        scopeKind: "repo-local",
        scopeRef: input.repoId,
        audience: { agents: input.agents, origins: ["ui"] },
        enabled: true,
      });
      const pack = registry.get(instanceId);
      if (!pack) throw new Error(`generated capability pack disappeared after creation: ${instanceId}`);
      return { pack, binding };
    } catch (error) {
      if (instanceId) {
        try { registry.remove(instanceId); } catch { /* preserve the original create failure */ }
      }
      if (sourcePath) {
        try { generatedPacks.remove(sourcePath); } catch { /* preserve the original create failure */ }
      }
      throw error;
    }
  }

  private createCatalogPack(
    manifest: CapabilityPackManifest,
    create: (generatedPacks: GeneratedCapabilityPackPort) => string,
    secretValues: Record<string, string> = {},
  ): CapabilityCatalogCreateResult {
    const registry = this.deps.registry;
    const generatedPacks = this.deps.generatedPacks;
    if (!registry) throw new Error("capability registry unavailable");
    if (!generatedPacks) throw new Error("generated capability pack store unavailable");

    let sourcePath: string | undefined;
    let instanceId: string | undefined;
    try {
      sourcePath = create(generatedPacks);
      const added = registry.add(sourcePath, { sourceKind: "rookery-generated" });
      instanceId = added.instanceId;
      for (const [key, value] of Object.entries(secretValues).sort(([a], [b]) => a.localeCompare(b))) {
        registry.setSecret(instanceId, key, value);
      }
      const pack = registry.get(instanceId);
      if (!pack) throw new Error(`generated capability pack disappeared after creation: ${instanceId}`);
      return { pack };
    } catch (error) {
      if (instanceId) {
        try { registry.remove(instanceId); } catch { /* preserve the original create failure */ }
      }
      if (sourcePath) {
        try { generatedPacks.remove(sourcePath); } catch { /* preserve the original create failure */ }
      }
      throw error;
    }
  }

  createMcp(input: CapabilityMcpCreateInput): CapabilityCatalogCreateResult {
    const manifest: CapabilityPackManifest = {
      schemaVersion: 1,
      id: input.id,
      displayName: input.displayName,
      version: "1.0.0",
      description: input.description,
      mcpServers: [input.mcpServer],
    };
    return this.createCatalogPack(manifest, (store) => store.create(manifest), input.secretValues);
  }

  createSkill(input: CapabilitySkillCreateInput): CapabilityCatalogCreateResult {
    const manifest: CapabilityPackManifest = {
      schemaVersion: 1,
      id: input.id,
      displayName: input.displayName,
      version: "1.0.0",
      description: input.description,
      skills: [{ id: input.id, path: "skill" }],
    };
    return this.createCatalogPack(manifest, (store) => store.createSkill(manifest, input.sourcePath));
  }

  removePack(instanceId: string): void {
    if (!this.deps.registry) throw new Error("capability registry unavailable");
    const pack = this.deps.registry.get(instanceId);
    this.deps.registry.remove(instanceId);
    if (pack?.sourceKind === "rookery-generated") {
      if (!this.deps.generatedPacks) throw new Error("generated capability pack store unavailable");
      this.deps.generatedPacks.remove(pack.sourcePath);
    }
  }

  setBinding(id: string, input: CapabilityBindingInput): CapabilityBinding {
    if (!this.deps.registry) throw new Error("capability registry unavailable");
    return this.deps.registry.setBinding(id, input);
  }

  quickSetBinding(input: CapabilityQuickBindingInput): CapabilityBinding | null {
    if (!this.deps.registry) throw new Error("capability registry unavailable");
    return this.deps.registry.quickSetBinding(input);
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
    target: ResolvedCapabilityTarget,
  ): CapabilityEntry[] {
    if (!runtime) return entries;
    return entries.map((entry) => {
      // Resolver-specific blocking/unavailability/suppression is more precise than revision drift and
      // must survive projection. Runtime state only replaces entries that were launchable (`desired`).
      let projected = entry;
      if (entry.managed && entry.state === "desired") {
        if (runtime.state === "current") projected = { ...entry, state: "applied", evidence: "runtime" };
        else if (runtime.state === "pending-next-turn" || runtime.state === "pending-reload") {
          projected = { ...entry, state: runtime.state };
        } else if (runtime.state === "blocked" || runtime.state === "error") {
          projected = { ...entry, state: runtime.state };
        }
      }
      const invocableManagedSkill = Boolean(projected.managed)
        && projected.kind === "skill"
        && (projected.state === "applied" || (target.kind === "master" && projected.state === "pending-next-turn"));
      if (invocableManagedSkill) {
        const prefix = target.provider === "codex" ? "$" : "/";
        return { ...projected, invocation: { type: "prompt", name: `${prefix}${projected.name}` } };
      }
      if (!projected.invocation) return projected;
      const { invocation: _invocation, ...withoutInvocation } = projected;
      return withoutInvocation;
    });
  }

  private projectPreviewEntries(entries: CapabilityEntry[]): CapabilityEntry[] {
    return entries.map((entry) => {
      const projected = entry.state === "applied"
        ? { ...entry, state: "desired" as const, evidence: "declared" as const }
        : entry;
      if (!projected.invocation) return projected;
      const { invocation: _invocation, ...withoutInvocation } = projected;
      return withoutInvocation;
    });
  }

  private resolveTarget(target: CapabilityTarget): {
    label: string;
    provider: "claude" | "codex";
    cwd: string | null;
    desired: ResolvedCapabilityTarget;
    preview: boolean;
  } {
    if (target.kind === "rookery" || target.kind === "repo") return this.resolvePreviewTarget(target);
    return this.resolveLiveTarget(target);
  }

  private resolvePreviewTarget(target: CapabilityPreviewTarget): {
    label: string;
    provider: "claude" | "codex";
    cwd: string | null;
    desired: ResolvedCapabilityTarget;
    preview: true;
  } {
    if (target.kind === "rookery") {
      return {
        label: "Rookery defaults",
        provider: target.provider,
        cwd: null,
        desired: {
          kind: target.agent,
          id: `preview:rookery:${target.provider}:${target.agent}`,
          provider: target.provider,
          origin: "ui",
          cwd: "",
        },
        preview: true,
      };
    }

    const repo = (this.deps.listRepos?.() ?? []).find((candidate) => candidate.id === target.id);
    if (!repo) throw new Error(`unknown capability target: repo:${target.id}`);
    return {
      label: repo.name?.trim() || repo.path,
      provider: target.provider,
      cwd: repo.path,
      desired: {
        kind: target.agent,
        id: `preview:repo:${repo.id}:${target.provider}:${target.agent}`,
        provider: target.provider,
        origin: "ui",
        cwd: repo.path,
        repoId: repo.id,
      },
      preview: true,
    };
  }

  private resolveLiveTarget(target: CapabilityLiveTarget): {
    label: string;
    provider: "claude" | "codex";
    cwd: string;
    desired: ResolvedCapabilityTarget;
    preview: false;
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
        preview: false,
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
      preview: false,
    };
  }
}
