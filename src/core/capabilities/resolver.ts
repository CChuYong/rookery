import { createHash } from "node:crypto";
import type { CapabilityRegistry } from "./registry.js";
import type {
  CapabilityBinding,
  CapabilityDiagnostic,
  CapabilityEntry,
  CapabilityKind,
  CapabilityLibraryEntry,
  CapabilityOrigin,
  CapabilityProvider,
  CapabilityScope,
  CapabilityScopeKind,
  CapabilityState,
  McpServerSpec,
  SecretRef,
} from "./types.js";

export interface ResolvedCapabilityTarget {
  kind: "master" | "worker" | "side";
  id: string;
  provider: Exclude<CapabilityProvider, "rookery">;
  origin: CapabilityOrigin;
  cwd: string;
  repoId?: string;
  homeSessionId?: string;
}

export interface DesiredCapabilityManifest {
  revision: string;
  blocked: boolean;
  entries: CapabilityEntry[];
  diagnostics: CapabilityDiagnostic[];
}

export interface CapabilityResolverOptions {
  env?: NodeJS.ProcessEnv;
}

interface SelectedPack {
  pack: CapabilityLibraryEntry;
  binding: CapabilityBinding;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => compareText(a, b))
      .map(([key, nested]) => [key, stableValue(nested)]));
  }
  return value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function bindingRank(binding: CapabilityBinding): number {
  switch (binding.scopeKind) {
    case "worker": return 4;
    case "session": return 3;
    case "repo-local":
    case "repo-shared": return 2;
    case "rookery": return 1;
  }
}

function bindingMatchesTarget(binding: CapabilityBinding, target: ResolvedCapabilityTarget): boolean {
  if (!binding.audience.agents.includes(target.kind) || !binding.audience.origins.includes(target.origin)) return false;
  switch (binding.scopeKind) {
    case "rookery": return binding.scopeRef === "";
    case "repo-local":
    case "repo-shared": return target.repoId !== undefined && binding.scopeRef === target.repoId;
    case "session": return target.homeSessionId !== undefined && binding.scopeRef === target.homeSessionId;
    case "worker": return target.kind === "worker" && binding.scopeRef === target.id;
  }
}

function scopeForBinding(scopeKind: CapabilityScopeKind): CapabilityScope {
  switch (scopeKind) {
    case "worker": return "worker";
    case "session": return "session";
    case "repo-local":
    case "repo-shared": return "repo";
    case "rookery": return "system";
  }
}

function refsForServer(server: McpServerSpec): SecretRef[] {
  if (server.transport === "stdio") return Object.values(server.secretEnv ?? {});
  return [
    ...Object.values(server.secretHeaders ?? {}),
    ...(server.auth ? [server.auth.bearerToken] : []),
  ];
}

function publicServerSpec(server: McpServerSpec): unknown {
  if (server.transport === "stdio") {
    return {
      ...server,
      secretEnv: Object.fromEntries(Object.entries(server.secretEnv ?? {}).sort(([a], [b]) => compareText(a, b))),
    };
  }
  return {
    ...server,
    secretHeaders: Object.fromEntries(Object.entries(server.secretHeaders ?? {}).sort(([a], [b]) => compareText(a, b))),
  };
}

export class CapabilityResolver {
  private readonly env: NodeJS.ProcessEnv;

  constructor(
    private readonly registry: CapabilityRegistry,
    options: CapabilityResolverOptions = {},
  ) {
    this.env = options.env ?? process.env;
  }

  private select(target: ResolvedCapabilityTarget): SelectedPack[] {
    const library = this.registry.list();
    const packs = new Map(library.packs.map((pack) => [pack.instanceId, pack]));
    const grouped = new Map<string, CapabilityBinding[]>();
    for (const binding of library.bindings) {
      if (!bindingMatchesTarget(binding, target)) continue;
      const values = grouped.get(binding.packInstanceId) ?? [];
      values.push(binding);
      grouped.set(binding.packInstanceId, values);
    }
    const selected: SelectedPack[] = [];
    for (const [instanceId, bindings] of grouped) {
      const pack = packs.get(instanceId);
      if (!pack) continue;
      const binding = [...bindings].sort((a, b) =>
        bindingRank(b) - bindingRank(a)
        || compareText(a.scopeKind, b.scopeKind)
        || compareText(a.id, b.id))[0]!;
      selected.push({ pack, binding });
    }
    return selected.sort((a, b) =>
      compareText(a.pack.manifest.id, b.pack.manifest.id)
      || compareText(a.pack.instanceId, b.pack.instanceId));
  }

  private requirementSignals(pack: CapabilityLibraryEntry): Array<{
    source: SecretRef["source"];
    key: string;
    configured: boolean;
    version?: number;
  }> {
    const versions = this.registry.getSecretVersions(pack.instanceId);
    const signals = new Map<string, { source: SecretRef["source"]; key: string; configured: boolean; version?: number }>();
    for (const server of pack.manifest.mcpServers ?? []) {
      for (const ref of refsForServer(server)) {
        if (ref.source === "rookery-secret") {
          const version = versions.get(ref.key);
          signals.set(`rookery-secret:${ref.key}`, {
            source: ref.source,
            key: ref.key,
            configured: version !== undefined,
            ...(version === undefined ? {} : { version }),
          });
        } else {
          signals.set(`environment:${ref.name}`, {
            source: ref.source,
            key: ref.name,
            configured: Boolean(this.env[ref.name]),
          });
        }
      }
    }
    return [...signals.values()].sort((a, b) => compareText(a.source, b.source) || compareText(a.key, b.key));
  }

  private stateForPack(pack: CapabilityLibraryEntry, binding: CapabilityBinding): CapabilityState {
    if (!binding.enabled) return "suppressed";
    return pack.status === "trusted" ? "desired" : "blocked";
  }

  resolve(target: ResolvedCapabilityTarget): DesiredCapabilityManifest {
    const selected = this.select(target);
    const entries: CapabilityEntry[] = [];
    const diagnostics: CapabilityDiagnostic[] = [];
    let blocked = false;
    const revisionProjection: unknown[] = [];

    for (const { pack, binding } of selected) {
      const baseState = this.stateForPack(pack, binding);
      if (baseState === "blocked") {
        blocked = true;
        diagnostics.push({
          id: `managed:${pack.instanceId}:status`,
          source: pack.manifest.displayName,
          severity: "error",
          message: `Capability pack is ${pack.status}; review or repair it before use.`,
        });
      }
      const managed = {
        packInstanceId: pack.instanceId,
        packId: pack.manifest.id,
        bindingId: binding.id,
        scopeKind: binding.scopeKind,
        enabled: binding.enabled,
      };
      const common = {
        provider: "rookery" as const,
        source: pack.manifest.displayName,
        scope: scopeForBinding(binding.scopeKind),
        evidence: "declared" as const,
        managed,
      };

      for (const instruction of pack.manifest.instructions ?? []) {
        entries.push({
          id: `managed:${pack.instanceId}:instruction:${instruction.id}`,
          kind: "instruction",
          name: instruction.id,
          description: pack.manifest.description,
          detail: instruction.path,
          state: baseState,
          ...common,
        });
      }
      for (const skill of pack.manifest.skills ?? []) {
        entries.push({
          id: `managed:${pack.instanceId}:skill:${skill.id}`,
          kind: "skill",
          name: skill.id,
          description: pack.manifest.description,
          detail: skill.path,
          state: baseState,
          ...common,
        });
      }
      for (const server of pack.manifest.mcpServers ?? []) {
        let state = baseState;
        if (baseState === "desired" && target.kind === "side") {
          state = "suppressed";
          diagnostics.push({
            id: `managed:${pack.instanceId}:mcp:${server.id}:side`,
            source: pack.manifest.displayName,
            severity: "info",
            message: `MCP server ${server.id} is suppressed for Side agents.`,
          });
        } else if (baseState === "desired") {
          const missing = refsForServer(server).filter((ref) =>
            ref.source === "rookery-secret"
              ? this.registry.getSecretVersions(pack.instanceId).get(ref.key) === undefined
              : !this.env[ref.name]);
          if (missing.length > 0) {
            state = server.required ? "blocked" : "unavailable";
            if (server.required) blocked = true;
            diagnostics.push({
              id: `managed:${pack.instanceId}:mcp:${server.id}:missing`,
              source: pack.manifest.displayName,
              severity: server.required ? "error" : "warning",
              message: `MCP server ${server.id} is missing ${missing.map((ref) =>
                ref.source === "rookery-secret" ? `secret ${ref.key}` : `environment ${ref.name}`).join(", ")}.`,
            });
          }
        }
        entries.push({
          id: `managed:${pack.instanceId}:mcp:${server.id}`,
          kind: "mcp",
          name: server.id,
          description: pack.manifest.description,
          detail: server.transport,
          state,
          ...common,
        });
      }

      revisionProjection.push({
        instanceId: pack.instanceId,
        digest: pack.digest,
        status: pack.status,
        binding: {
          id: binding.id,
          scopeKind: binding.scopeKind,
          scopeRef: binding.scopeRef,
          audience: binding.audience,
          enabled: binding.enabled,
        },
        publicSpec: {
          instructions: pack.manifest.instructions ?? [],
          skills: pack.manifest.skills ?? [],
          mcpServers: (pack.manifest.mcpServers ?? []).map(publicServerSpec),
        },
        requirements: this.requirementSignals(pack),
      });
    }

    const kindOrder: CapabilityKind[] = ["instruction", "mcp", "skill", "command", "tool", "hook", "plugin", "app"];
    entries.sort((a, b) =>
      compareText(a.managed?.packId ?? "", b.managed?.packId ?? "")
      || kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind)
      || compareText(a.name, b.name)
      || compareText(a.id, b.id));
    diagnostics.sort((a, b) => compareText(a.source, b.source) || compareText(a.id, b.id));
    const revision = createHash("sha256")
      .update(stableStringify({ targetKind: target.kind, selected: revisionProjection }))
      .digest("hex");
    return { revision, blocked, entries, diagnostics };
  }
}
