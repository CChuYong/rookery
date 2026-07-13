import { CodexClient } from "./codex/codex-client.js";
import type { CodexSpawn } from "./codex/codex-transport.js";
import type {
  CapabilityContribution,
  CapabilityDiagnostic,
  CapabilityEntry,
  CapabilityScope,
  CapabilityState,
} from "./capabilities/types.js";
import { sortCapabilityDiagnostics, sortCapabilityEntries } from "./capabilities/types.js";

const CLIENT_INFO = { name: "rookery", title: "rookery", version: "0.1.0" };
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_PAGES = 20;

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as UnknownRecord : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanValue(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function arrayValue(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function malformed(id: string, source: string, expected: string): CapabilityContribution {
  return {
    entries: [],
    diagnostics: [{ id, source, severity: "warning", message: `Malformed ${source} response: expected ${expected}.` }],
  };
}

function diagnostic(id: string, source: string, message: string): CapabilityDiagnostic {
  return { id, source, severity: "warning", message };
}

function joinDetails(parts: Array<string | undefined>): string | undefined {
  const detail = parts.filter((part): part is string => !!part).join(" · ");
  return detail || undefined;
}

function capabilityScope(value: unknown, fallback: CapabilityScope = "session"): CapabilityScope {
  switch (stringValue(value)?.toLowerCase()) {
    case "repo":
    case "project": return "repo";
    case "user": return "user";
    case "system": return "system";
    case "admin":
    case "mdm":
    case "enterprisemanaged":
    case "enterprise_managed": return "admin";
    case "plugin": return "plugin";
    case "worker": return "worker";
    case "session":
    case "sessionflags":
    case "session_flags": return "session";
    default: return fallback;
  }
}

function sorted(contribution: CapabilityContribution): CapabilityContribution {
  return {
    entries: sortCapabilityEntries(contribution.entries),
    diagnostics: sortCapabilityDiagnostics(contribution.diagnostics),
  };
}

export function mapSkillsResponse(value: unknown): CapabilityContribution {
  const source = "Codex skills/list";
  const data = arrayValue(record(value)?.data);
  if (!data) return malformed("codex.skills.malformed", source, "data[]");
  const entries: CapabilityEntry[] = [];
  const diagnostics: CapabilityDiagnostic[] = [];

  for (const rawGroup of data) {
    const group = record(rawGroup);
    if (!group) continue;
    for (const rawSkill of arrayValue(group.skills) ?? []) {
      const skill = record(rawSkill);
      const name = stringValue(skill?.name);
      const path = stringValue(skill?.path);
      if (!skill || !name || !path) continue;
      entries.push({
        id: `codex.skill.${name.toLowerCase()}.${path}`,
        kind: "skill",
        name,
        description: stringValue(skill.description) ?? stringValue(skill.shortDescription),
        detail: path,
        provider: "codex",
        source,
        scope: capabilityScope(skill.scope, "user"),
        state: booleanValue(skill.enabled) ? "applied" : "unavailable",
        evidence: "runtime",
      });
    }
    for (const rawError of arrayValue(group.errors) ?? []) {
      const loadError = record(rawError);
      const path = stringValue(loadError?.path) ?? "unknown path";
      const message = stringValue(loadError?.message) ?? "Unknown skill load error";
      diagnostics.push(diagnostic(`codex.skills.load.${path}`, source, `${path}: ${message}`));
    }
  }
  return sorted({ entries, diagnostics });
}

function hookScope(source: unknown): CapabilityScope {
  return capabilityScope(source, "session");
}

function hookState(enabled: boolean, trustStatus: string | undefined): CapabilityState {
  if (!enabled) return "unavailable";
  if (trustStatus === "untrusted" || trustStatus === "modified") return "blocked";
  return "applied";
}

export function mapHooksResponse(value: unknown): CapabilityContribution {
  const source = "Codex hooks/list";
  const data = arrayValue(record(value)?.data);
  if (!data) return malformed("codex.hooks.malformed", source, "data[]");
  const entries: CapabilityEntry[] = [];
  const diagnostics: CapabilityDiagnostic[] = [];

  for (const rawGroup of data) {
    const group = record(rawGroup);
    if (!group) continue;
    for (const rawHook of arrayValue(group.hooks) ?? []) {
      const hook = record(rawHook);
      const key = stringValue(hook?.key);
      const path = stringValue(hook?.sourcePath);
      if (!hook || !key || !path) continue;
      const trustStatus = stringValue(hook.trustStatus)?.toLowerCase();
      entries.push({
        id: `codex.hook.${key.toLowerCase()}.${path}`,
        kind: "hook",
        name: key,
        description: joinDetails([stringValue(hook.eventName), stringValue(hook.handlerType)]),
        detail: joinDetails([stringValue(hook.matcher), stringValue(hook.command), path, trustStatus]),
        provider: "codex",
        source,
        scope: hookScope(hook.source),
        state: hookState(booleanValue(hook.enabled), trustStatus),
        evidence: "runtime",
      });
    }
    for (const warning of arrayValue(group.warnings) ?? []) {
      const message = stringValue(warning);
      if (message) diagnostics.push(diagnostic(`codex.hooks.warning.${diagnostics.length}`, source, message));
    }
    for (const rawError of arrayValue(group.errors) ?? []) {
      const loadError = record(rawError);
      const path = stringValue(loadError?.path) ?? "unknown path";
      const message = stringValue(loadError?.message) ?? "Unknown hook load error";
      diagnostics.push(diagnostic(`codex.hooks.load.${path}`, source, `${path}: ${message}`));
    }
  }
  return sorted({ entries, diagnostics });
}

function authLabel(authStatus: string | undefined): string {
  switch (authStatus) {
    case "oAuth": return "OAuth";
    case "bearerToken": return "Bearer token";
    case "notLoggedIn": return "Not logged in";
    case "unsupported": return "No authentication required";
    default: return authStatus ?? "Authentication unknown";
  }
}

export function mapMcpResponse(value: unknown): CapabilityContribution {
  const source = "Codex mcpServerStatus/list";
  const data = arrayValue(record(value)?.data);
  if (!data) return malformed("codex.mcp.malformed", source, "data[]");
  const entries: CapabilityEntry[] = [];
  for (const rawServer of data) {
    const server = record(rawServer);
    const name = stringValue(server?.name);
    if (!server || !name) continue;
    const tools = record(server.tools);
    const authStatus = stringValue(server.authStatus);
    const toolCount = tools ? Object.keys(tools).length : 0;
    entries.push({
      id: `codex.mcp.${name.toLowerCase()}`,
      kind: "mcp",
      name,
      description: "MCP server available to Codex.",
      detail: `${authLabel(authStatus)} · ${toolCount} ${toolCount === 1 ? "tool" : "tools"}`,
      provider: "codex",
      source,
      scope: "session",
      state: authStatus === "notLoggedIn" ? "unavailable" : "applied",
      evidence: "runtime",
    });
  }
  return sorted({ entries, diagnostics: [] });
}

export function mapPluginResponse(value: unknown): CapabilityContribution {
  const source = "Codex plugin/list";
  const root = record(value);
  const marketplaces = arrayValue(root?.marketplaces);
  if (!marketplaces) return malformed("codex.plugins.malformed", source, "marketplaces[]");
  const entries: CapabilityEntry[] = [];
  const diagnostics: CapabilityDiagnostic[] = [];

  for (const rawMarketplace of marketplaces) {
    const marketplace = record(rawMarketplace);
    if (!marketplace) continue;
    const marketplaceName = stringValue(marketplace.name) ?? "unknown marketplace";
    const marketplacePath = stringValue(marketplace.path);
    for (const rawPlugin of arrayValue(marketplace.plugins) ?? []) {
      const plugin = record(rawPlugin);
      const id = stringValue(plugin?.id);
      const name = stringValue(plugin?.name);
      if (!plugin || !id || !name || !booleanValue(plugin.installed)) continue;
      const pluginInterface = record(plugin.interface);
      const availability = stringValue(plugin.availability);
      const state: CapabilityState = availability === "DISABLED_BY_ADMIN"
        ? "blocked"
        : booleanValue(plugin.enabled) ? "applied" : "unavailable";
      entries.push({
        id: `codex.plugin.${id.toLowerCase()}`,
        kind: "plugin",
        name: stringValue(pluginInterface?.displayName) ?? name,
        description: stringValue(pluginInterface?.shortDescription) ?? stringValue(pluginInterface?.longDescription),
        detail: joinDetails([marketplaceName, marketplacePath, stringValue(plugin.localVersion)]),
        provider: "codex",
        source,
        scope: "plugin",
        state,
        evidence: "runtime",
      });
    }
  }
  for (const rawError of arrayValue(root?.marketplaceLoadErrors) ?? []) {
    const loadError = record(rawError);
    const path = stringValue(loadError?.marketplacePath) ?? "unknown marketplace";
    const message = stringValue(loadError?.message) ?? "Unknown marketplace load error";
    diagnostics.push(diagnostic(`codex.plugins.load.${path}`, source, `${path}: ${message}`));
  }
  return sorted({ entries, diagnostics });
}

export function mapAppsResponse(value: unknown): CapabilityContribution {
  const source = "Codex app/list";
  const data = arrayValue(record(value)?.data);
  if (!data) return malformed("codex.apps.malformed", source, "data[]");
  const entries: CapabilityEntry[] = [];
  for (const rawApp of data) {
    const app = record(rawApp);
    const id = stringValue(app?.id);
    const name = stringValue(app?.name);
    if (!app || !id || !name) continue;
    const accessible = booleanValue(app.isAccessible);
    const enabled = booleanValue(app.isEnabled, true);
    // app/list is also a discovery catalog (thousands of unlinked apps). Effective inventory should
    // include apps Codex can actually use plus explicit config disables, not every catalog candidate.
    if (!accessible && enabled) continue;
    const pluginNames = arrayValue(app.pluginDisplayNames)?.map(stringValue).filter((part): part is string => !!part);
    entries.push({
      id: `codex.app.${id.toLowerCase()}`,
      kind: "app",
      name,
      description: stringValue(app.description),
      detail: pluginNames?.length ? `Plugins: ${pluginNames.join(", ")}` : undefined,
      provider: "codex",
      source,
      scope: "plugin",
      state: accessible && enabled ? "applied" : "unavailable",
      evidence: "runtime",
    });
  }
  return sorted({ entries, diagnostics: [] });
}

function configLayerIdentity(value: unknown): { type: string; scope: CapabilityScope; location?: string } {
  if (typeof value === "string") return { type: value, scope: capabilityScope(value) };
  const layer = record(value);
  const type = stringValue(layer?.type) ?? "unknown";
  const location = stringValue(layer?.file)
    ?? stringValue(layer?.dotCodexFolder)
    ?? stringValue(layer?.id)
    ?? joinDetails([stringValue(layer?.domain), stringValue(layer?.key)]);
  return { type, scope: capabilityScope(type), ...(location ? { location } : {}) };
}

export function mapConfigResponse(value: unknown): CapabilityContribution {
  const source = "Codex config/read";
  const root = record(value);
  if (!root || !("layers" in root) || (root.layers !== null && !Array.isArray(root.layers))) {
    return malformed("codex.config.malformed", source, "layers[] or layers: null");
  }
  const entries: CapabilityEntry[] = [];
  for (const rawLayer of arrayValue(root.layers) ?? []) {
    const layer = record(rawLayer);
    if (!layer) continue;
    const identity = configLayerIdentity(layer.name);
    const disabledReason = stringValue(layer.disabledReason);
    const suffix = identity.location ?? stringValue(layer.version) ?? identity.type;
    entries.push({
      id: `codex.instruction.${identity.type.toLowerCase()}.${suffix}`,
      kind: "instruction",
      name: `Codex ${identity.type} configuration`,
      description: "A configuration layer contributing to the effective Codex session.",
      detail: joinDetails([identity.location, disabledReason]),
      provider: "codex",
      source,
      scope: identity.scope,
      state: disabledReason ? "unavailable" : "applied",
      evidence: "declared",
    });
  }
  return sorted({ entries, diagnostics: [] });
}

export interface CodexCapabilitiesProvider {
  list(input: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<CapabilityContribution>;
}

interface ProbeSpec {
  id: string;
  source: string;
  run(client: CodexClient, timeoutMs: number): Promise<CapabilityContribution>;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function requestProbe(
  client: CodexClient,
  timeoutMs: number,
  method: string,
  params: UnknownRecord,
  mapper: (value: unknown) => CapabilityContribution,
): Promise<CapabilityContribution> {
  const result = await withTimeout(client.request(method, params), timeoutMs, method);
  return mapper(result);
}

async function pagedProbe(
  client: CodexClient,
  timeoutMs: number,
  method: string,
  baseParams: UnknownRecord,
  mapper: (value: unknown) => CapabilityContribution,
): Promise<CapabilityContribution> {
  const entries: CapabilityEntry[] = [];
  const diagnostics: CapabilityDiagnostic[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await withTimeout(client.request(method, { ...baseParams, ...(cursor ? { cursor } : {}) }), timeoutMs, method);
    const contribution = mapper(result);
    entries.push(...contribution.entries);
    diagnostics.push(...contribution.diagnostics);
    const nextCursor = stringValue(record(result)?.nextCursor);
    if (!nextCursor) return sorted({ entries, diagnostics });
    if (seen.has(nextCursor)) {
      diagnostics.push(diagnostic(`codex.${method}.cursor-loop`, `Codex ${method}`, `Pagination cursor repeated: ${nextCursor}`));
      return sorted({ entries, diagnostics });
    }
    seen.add(nextCursor);
    cursor = nextCursor;
  }
  diagnostics.push(diagnostic(`codex.${method}.page-limit`, `Codex ${method}`, `Pagination exceeded ${MAX_PAGES} pages.`));
  return sorted({ entries, diagnostics });
}

async function executeProbe(client: CodexClient, timeoutMs: number, spec: ProbeSpec): Promise<CapabilityContribution> {
  try {
    return await spec.run(client, timeoutMs);
  } catch (error) {
    return { entries: [], diagnostics: [diagnostic(spec.id, spec.source, errorMessage(error))] };
  }
}

export function makeCodexCapabilitiesProvider(opts: {
  spawn: CodexSpawn;
  env?: () => NodeJS.ProcessEnv | undefined;
  apiKey?: () => string | undefined;
  timeoutMs?: number;
}): CodexCapabilitiesProvider {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    async list(input) {
      let client: CodexClient | undefined;
      const setupDiagnostics: CapabilityDiagnostic[] = [];
      try {
        client = new CodexClient(opts.spawn({ env: { ...(opts.env?.() ?? {}), ...(input.env ?? {}) } }));
        await withTimeout(
          client.request("initialize", { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: true, requestAttestation: false } }),
          timeoutMs,
          "codex initialize",
        );
        client.notify("initialized", {});

        const apiKey = opts.apiKey?.();
        if (apiKey) {
          try {
            const account = await withTimeout(client.request("account/read", {}), timeoutMs, "account/read") as { requiresOpenaiAuth?: boolean } | null;
            if (account?.requiresOpenaiAuth) {
              await withTimeout(client.request("account/login/start", { type: "apiKey", apiKey }), timeoutMs, "account/login/start");
            }
          } catch (error) {
            setupDiagnostics.push(diagnostic("codex.auth.provision", "Codex account", errorMessage(error)));
          }
        }

        const probes: ProbeSpec[] = [
          {
            id: "codex.skills.probe",
            source: "Codex skills/list",
            run: (c, ms) => requestProbe(c, ms, "skills/list", { cwds: [input.cwd], forceReload: false }, mapSkillsResponse),
          },
          {
            id: "codex.hooks.probe",
            source: "Codex hooks/list",
            run: (c, ms) => requestProbe(c, ms, "hooks/list", { cwds: [input.cwd] }, mapHooksResponse),
          },
          {
            id: "codex.mcp.probe",
            source: "Codex mcpServerStatus/list",
            run: (c, ms) => pagedProbe(c, ms, "mcpServerStatus/list", { limit: 100, detail: "toolsAndAuthOnly" }, mapMcpResponse),
          },
          {
            id: "codex.plugins.probe",
            source: "Codex plugin/list",
            run: (c, ms) => requestProbe(c, ms, "plugin/list", { cwds: [input.cwd], marketplaceKinds: ["local"] }, mapPluginResponse),
          },
          {
            id: "codex.apps.probe",
            source: "Codex app/list",
            // app/list is a directory-sized catalog and the server accepts the requested page size
            // without a low cap. Read it in one normally-sized response, then retain effective apps.
            run: (c, ms) => pagedProbe(c, ms, "app/list", { limit: 10_000, forceRefetch: false }, mapAppsResponse),
          },
          {
            id: "codex.config.probe",
            source: "Codex config/read",
            run: (c, ms) => requestProbe(c, ms, "config/read", { cwd: input.cwd, includeLayers: true }, mapConfigResponse),
          },
        ];
        const contributions = await Promise.all(probes.map((probe) => executeProbe(client!, timeoutMs, probe)));
        return sorted({
          entries: contributions.flatMap((contribution) => contribution.entries),
          diagnostics: [...setupDiagnostics, ...contributions.flatMap((contribution) => contribution.diagnostics)],
        });
      } catch (error) {
        return {
          entries: [],
          diagnostics: [{
            id: "codex.app-server",
            source: "Codex app-server",
            severity: "error",
            message: errorMessage(error),
          }],
        };
      } finally {
        client?.close();
      }
    },
  };
}
