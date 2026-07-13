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

export type CapabilityState = "applied" | "unavailable" | "blocked" | "error";
export type CapabilityEvidence = "runtime" | "declared" | "inferred";
export type CapabilityScope = "builtin" | "session" | "worker" | "repo" | "user" | "system" | "admin" | "plugin";

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
}

export interface CapabilityDiagnostic {
  id: string;
  source: string;
  severity: "warning" | "error";
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
