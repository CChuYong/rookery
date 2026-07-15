export type CapabilityTarget =
  | { kind: "session"; id: string }
  | { kind: "worker"; id: string };

export type CapabilityProvider = "rookery" | "claude" | "codex";

export type CapabilityKind =
  | "instruction"
  | "skill"
  | "command"
  | "tool"
  | "mcp"
  | "hook"
  | "plugin"
  | "app";

export type CapabilityState =
  | "applied"
  | "desired"
  | "pending-next-turn"
  | "pending-reload"
  | "unavailable"
  | "blocked"
  | "suppressed"
  | "error";
export type CapabilityEvidence = "runtime" | "declared" | "inferred";
export type CapabilityScope = "builtin" | "session" | "worker" | "repo" | "user" | "system" | "admin" | "plugin";

export type CapabilityAgentKind = "master" | "worker" | "side";
export type CapabilityOrigin = "ui" | "slack" | "automation" | "external";
export type CapabilityScopeKind = "rookery" | "repo-local" | "repo-shared" | "session" | "worker";
export type CapabilityPackSourceKind = "rookery-generated" | "local-directory" | "repo-shared";
export type CapabilityPackStatus = "trusted" | "untrusted" | "invalid" | "source-missing";

export interface CapabilityAudience {
  agents: CapabilityAgentKind[];
  origins: CapabilityOrigin[];
}

export interface CapabilityBindingInput {
  id?: string;
  packInstanceId: string;
  scopeKind: CapabilityScopeKind;
  scopeRef: string;
  audience: CapabilityAudience;
  enabled: boolean;
}

export interface CapabilityBinding {
  id: string;
  packInstanceId: string;
  scopeKind: CapabilityScopeKind;
  scopeRef: string;
  audience: CapabilityAudience;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CapabilityScopeRef {
  scopeKind: CapabilityScopeKind;
  scopeRef: string;
}

export interface InstructionSpec {
  id: string;
  path: string;
}

export interface SkillSpec {
  id: string;
  path: string;
}

export type SecretRef =
  | { source: "rookery-secret"; key: string }
  | { source: "environment"; name: string };

export interface McpCommon {
  id: string;
  enabledTools?: string[];
  disabledTools?: string[];
  required?: boolean;
  startupTimeoutSec?: number;
  toolTimeoutSec?: number;
}

export interface StdioMcpServerSpec extends McpCommon {
  transport: "stdio";
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  secretEnv?: Record<string, SecretRef>;
}

export interface HttpMcpServerSpec extends McpCommon {
  transport: "streamable-http";
  url: string;
  headers?: Record<string, string>;
  secretHeaders?: Record<string, SecretRef>;
  auth?: { bearerToken: SecretRef };
}

export type McpServerSpec = StdioMcpServerSpec | HttpMcpServerSpec;

export interface CapabilityPackManifest {
  schemaVersion: 1;
  id: string;
  displayName: string;
  version: string;
  description: string;
  instructions?: InstructionSpec[];
  skills?: SkillSpec[];
  mcpServers?: McpServerSpec[];
}

export interface CapabilityPackFile {
  path: string;
  mode: number;
  size: number;
  executable: boolean;
  sha256: string;
}

export interface CapabilityPackChange {
  path: string;
  kind: "added" | "modified" | "removed";
}

export interface CapabilitySecretStatus {
  key: string;
  configured: boolean;
}

export interface CapabilityLibraryEntry {
  instanceId: string;
  sourceKind: CapabilityPackSourceKind;
  sourcePath: string;
  ownerRepoId: string | null;
  manifest: CapabilityPackManifest;
  digest: string;
  status: CapabilityPackStatus;
  errors: string[];
  files: CapabilityPackFile[];
  changes: CapabilityPackChange[];
  secrets: CapabilitySecretStatus[];
  createdAt: string;
  updatedAt: string;
}

export interface CapabilityLibrarySnapshot {
  generation: number;
  packs: CapabilityLibraryEntry[];
  bindings: CapabilityBinding[];
  diagnostics: CapabilityDiagnostic[];
}

export interface CapabilityMcpPackCreateInput {
  id: string;
  displayName: string;
  version: string;
  description: string;
  repoId: string;
  agents: Array<"master" | "worker">;
  mcpServers: McpServerSpec[];
  secretValues?: Record<string, string>;
}

export interface CapabilityMcpPackCreateResult {
  pack: CapabilityLibraryEntry;
  binding: CapabilityBinding;
}

export interface ResolvedCapabilitySource {
  packInstanceId: string;
  packId: string;
  digest: string;
  sourcePath: string;
}

export interface ResolvedCapabilityFile extends ResolvedCapabilitySource {
  id: string;
  path: string;
}

export interface ResolvedMcpServer extends ResolvedCapabilitySource {
  generatedName: string;
  spec: McpServerSpec;
}

// Internal provider input. It is safe to pass across core/daemon boundaries because it contains
// public specs and secret references only; actual secret values are resolved by the daemon-owned
// runtime materializer immediately before the provider child is spawned.
export interface ResolvedAgentCapabilities {
  revision: string;
  blocked: boolean;
  instructions: ResolvedCapabilityFile[];
  skills: ResolvedCapabilityFile[];
  mcpServers: ResolvedMcpServer[];
}

export interface CapabilityEntry {
  id: string;
  kind: CapabilityKind;
  name: string;
  description?: string;
  detail?: string;
  provider: CapabilityProvider;
  source: string;
  scope: CapabilityScope;
  state: CapabilityState;
  evidence: CapabilityEvidence;
  invocation?: {
    type: "prompt" | "client-action" | "daemon-action" | "provider-action" | "tool";
    name?: string;
  };
  command?: {
    argumentHint?: string;
    aliases?: string[];
  };
  managed?: {
    packInstanceId: string;
    packId: string;
    bindingId: string;
    scopeKind: CapabilityScopeKind;
    enabled: boolean;
  };
}

export interface CapabilityDiagnostic {
  id: string;
  source: string;
  severity: "info" | "warning" | "error";
  message: string;
}

export interface CapabilityContribution {
  entries: CapabilityEntry[];
  diagnostics: CapabilityDiagnostic[];
}

export interface CapabilitySnapshot {
  target: CapabilityTarget & {
    label: string;
    provider: "claude" | "codex";
    cwd: string;
  };
  generatedAt: string;
  desiredRevision?: string;
  appliedRevision?: string | null;
  desiredBlocked?: boolean;
  entries: CapabilityEntry[];
  diagnostics: CapabilityDiagnostic[];
}

export function sortCapabilityEntries(entries: CapabilityEntry[]): CapabilityEntry[] {
  return [...entries].sort((a, b) =>
    a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
}

export function sortCapabilityDiagnostics(diagnostics: CapabilityDiagnostic[]): CapabilityDiagnostic[] {
  return [...diagnostics].sort((a, b) =>
    a.source.localeCompare(b.source) || a.id.localeCompare(b.id) || a.message.localeCompare(b.message),
  );
}
