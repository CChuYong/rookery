import type {
  CapabilityMcpPackCreateInput,
  McpServerSpec,
  SecretRef,
} from "@daemon/core/capabilities/types.js";

export interface McpKeyValueDraft {
  rowId: string;
  target: string;
  value: string;
}

export interface McpSecretDraft {
  rowId: string;
  target: string;
  key: string;
  value: string;
}

interface McpServerDraftBase {
  draftId: string;
  id: string;
  required: boolean;
  enabledToolsText: string;
  disabledToolsText: string;
  publicEntries: McpKeyValueDraft[];
  secretEntries: McpSecretDraft[];
}

export interface StdioMcpServerDraft extends McpServerDraftBase {
  transport: "stdio";
  command: string;
  argsText: string;
  cwd: string;
}

export interface HttpMcpServerDraft extends McpServerDraftBase {
  transport: "streamable-http";
  url: string;
  bearerSecretKey: string;
  bearerSecretValue: string;
}

export type McpServerDraft = StdioMcpServerDraft | HttpMcpServerDraft;

export interface McpPackDraft {
  displayName: string;
  id: string;
  version: string;
  description: string;
  repoId: string;
  agents: Array<"master" | "worker">;
  servers: McpServerDraft[];
}

export interface McpPackDraftIssue {
  code: string;
  serverIndex?: number;
  field?: string;
}

export type McpPackDraftCompileResult =
  | { ok: true; input: CapabilityMcpPackCreateInput }
  | { ok: false; issues: McpPackDraftIssue[] };

let nextDraftId = 0;

function draftId(prefix: string): string {
  nextDraftId += 1;
  return `${prefix}-${nextDraftId}`;
}

function commonServerDraft(transport: McpServerDraft["transport"]): McpServerDraftBase & { transport: McpServerDraft["transport"] } {
  return {
    draftId: draftId("server"),
    id: "",
    transport,
    required: false,
    enabledToolsText: "",
    disabledToolsText: "",
    publicEntries: [],
    secretEntries: [],
  };
}

export function createEmptyMcpServerDraft(transport: "stdio"): StdioMcpServerDraft;
export function createEmptyMcpServerDraft(transport: "streamable-http"): HttpMcpServerDraft;
export function createEmptyMcpServerDraft(transport: McpServerDraft["transport"]): McpServerDraft;
export function createEmptyMcpServerDraft(transport: McpServerDraft["transport"]): McpServerDraft {
  const common = commonServerDraft(transport);
  return transport === "stdio"
    ? { ...common, transport, command: "", argsText: "", cwd: "" }
    : { ...common, transport, url: "", bearerSecretKey: "", bearerSecretValue: "" };
}

export function createEmptyMcpKeyValueDraft(): McpKeyValueDraft {
  return { rowId: draftId("public"), target: "", value: "" };
}

export function createEmptyMcpSecretDraft(): McpSecretDraft {
  return { rowId: draftId("secret"), target: "", key: "", value: "" };
}

export function slugMcpId(value: string): string {
  return value.trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[-_.]+$/, "")
    .slice(0, 64);
}

function toolList(value: string): string[] | undefined {
  const items = value.split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
  const unique = [...new Set(items)].sort();
  return unique.length > 0 ? unique : undefined;
}

function args(value: string): string[] | undefined {
  const values = value.replace(/\r\n?/g, "\n").split("\n")
    .filter((item) => item.trim().length > 0);
  return values.length > 0 ? values : undefined;
}

function validHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function validRelativePath(value: string): boolean {
  return !value.includes("\0")
    && !value.includes("\\")
    && !value.startsWith("/")
    && !/^[A-Za-z]:[\\/]/.test(value)
    && !value.split("/").some((part) => part === "..");
}

export function compileMcpPackDraft(draft: McpPackDraft): McpPackDraftCompileResult {
  const issues: McpPackDraftIssue[] = [];
  const addIssue = (code: string, serverIndex?: number, field?: string): void => {
    issues.push({ code, ...(serverIndex === undefined ? {} : { serverIndex }), ...(field ? { field } : {}) });
  };
  const displayName = draft.displayName.trim();
  const id = slugMcpId(draft.id || displayName);
  const version = draft.version.trim();
  const description = draft.description.trim();
  const repoId = draft.repoId.trim();

  if (!displayName) addIssue("displayName.required");
  if (!id) addIssue("id.required");
  if (!version) addIssue("version.required");
  if (!repoId) addIssue("repo.required");
  const agents = [...new Set(draft.agents)].filter((agent): agent is "master" | "worker" => agent === "master" || agent === "worker");
  if (agents.length === 0) addIssue("agents.required");
  if (draft.servers.length === 0) addIssue("servers.required");

  const secretValues: Record<string, string> = {};
  const mcpServers: McpServerSpec[] = [];
  const normalizedServerIds = new Set<string>();
  const registerSecret = (key: string, value: string, serverIndex: number): void => {
    if (Object.hasOwn(secretValues, key) && secretValues[key] !== value) {
      addIssue("secret.valueConflict", serverIndex, key);
      return;
    }
    secretValues[key] = value;
  };

  for (const [serverIndex, draftServer] of draft.servers.entries()) {
    const serverId = slugMcpId(draftServer.id);
    if (!serverId) addIssue("server.idRequired", serverIndex, "id");
    const providerId = serverId.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    if (providerId && normalizedServerIds.has(providerId)) addIssue("server.idDuplicate", serverIndex, "id");
    else if (providerId) normalizedServerIds.add(providerId);

    const publicValues: Record<string, string> = {};
    const secretRefs: Record<string, SecretRef> = {};
    const normalizedTargets = new Set<string>();
    const normalizeTarget = (target: string): string => draftServer.transport === "streamable-http" ? target.toLowerCase() : target;

    for (const row of draftServer.publicEntries) {
      const target = row.target.trim();
      if (!target && !row.value) continue;
      if (!target) { addIssue("server.publicIncomplete", serverIndex, row.rowId); continue; }
      if (draftServer.transport === "stdio" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(target)) {
        addIssue("server.envNameInvalid", serverIndex, row.rowId);
        continue;
      }
      const normalized = normalizeTarget(target);
      if (normalizedTargets.has(normalized)) { addIssue("server.targetDuplicate", serverIndex, row.rowId); continue; }
      normalizedTargets.add(normalized);
      publicValues[target] = row.value;
    }

    for (const row of draftServer.secretEntries) {
      const target = row.target.trim();
      const key = row.key.trim();
      if (!target && !key && !row.value) continue;
      if (!target || !key || !row.value.trim()) { addIssue("server.secretIncomplete", serverIndex, row.rowId); continue; }
      if (draftServer.transport === "stdio" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(target)) {
        addIssue("server.envNameInvalid", serverIndex, row.rowId);
        continue;
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(key)) {
        addIssue("server.secretKeyInvalid", serverIndex, row.rowId);
        continue;
      }
      const normalized = normalizeTarget(target);
      if (normalizedTargets.has(normalized)) { addIssue("server.targetDuplicate", serverIndex, row.rowId); continue; }
      normalizedTargets.add(normalized);
      secretRefs[target] = { source: "rookery-secret", key };
      registerSecret(key, row.value, serverIndex);
    }

    const common = {
      id: serverId,
      ...(toolList(draftServer.enabledToolsText) ? { enabledTools: toolList(draftServer.enabledToolsText) } : {}),
      ...(toolList(draftServer.disabledToolsText) ? { disabledTools: toolList(draftServer.disabledToolsText) } : {}),
      ...(draftServer.required ? { required: true } : {}),
    };
    if (draftServer.transport === "stdio") {
      const command = draftServer.command.trim();
      const cwd = draftServer.cwd.trim();
      if (!command) addIssue("server.commandRequired", serverIndex, "command");
      if (cwd && !validRelativePath(cwd)) addIssue("server.cwdInvalid", serverIndex, "cwd");
      mcpServers.push({
        ...common,
        transport: "stdio",
        command,
        ...(args(draftServer.argsText) ? { args: args(draftServer.argsText) } : {}),
        ...(cwd ? { cwd } : {}),
        ...(Object.keys(publicValues).length ? { env: publicValues } : {}),
        ...(Object.keys(secretRefs).length ? { secretEnv: secretRefs } : {}),
      });
      continue;
    }

    const url = draftServer.url.trim();
    if (!url) addIssue("server.urlRequired", serverIndex, "url");
    else if (!validHttpUrl(url)) addIssue("server.urlInvalid", serverIndex, "url");
    const bearerKey = draftServer.bearerSecretKey.trim();
    const bearerValue = draftServer.bearerSecretValue;
    let auth: { bearerToken: SecretRef } | undefined;
    if (bearerKey || bearerValue) {
      if (!bearerKey || !bearerValue.trim()) addIssue("server.bearerIncomplete", serverIndex, "bearer");
      else if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(bearerKey)) addIssue("server.secretKeyInvalid", serverIndex, "bearer");
      else {
        auth = { bearerToken: { source: "rookery-secret", key: bearerKey } };
        registerSecret(bearerKey, bearerValue, serverIndex);
      }
    }
    mcpServers.push({
      ...common,
      transport: "streamable-http",
      url,
      ...(Object.keys(publicValues).length ? { headers: publicValues } : {}),
      ...(Object.keys(secretRefs).length ? { secretHeaders: secretRefs } : {}),
      ...(auth ? { auth } : {}),
    });
  }

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    input: {
      id,
      displayName,
      version,
      description,
      repoId,
      agents,
      mcpServers,
      ...(Object.keys(secretValues).length > 0 ? { secretValues } : {}),
    },
  };
}
