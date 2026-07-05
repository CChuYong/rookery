import type { CodexApprovalPolicy, CodexSandboxMode, CodexSandboxPolicy } from "./codex-protocol.js";

// rookery permissionMode → Codex approval/sandbox pair. Workers have no interactive
// approval channel, so every mode maps to approvalPolicy "never" and the sandbox does
// the enforcement (see spec §Vocabulary): bypass→danger, acceptEdits/default→workspace, plan→read-only.
export function mapPermissionMode(mode: string): { approvalPolicy: CodexApprovalPolicy; sandbox: CodexSandboxMode } {
  switch (mode) {
    case "acceptEdits":
    case "default":
      return { approvalPolicy: "never", sandbox: "workspace-write" };
    case "plan":
      return { approvalPolicy: "never", sandbox: "read-only" };
    case "bypassPermissions":
    default:
      return { approvalPolicy: "never", sandbox: "danger-full-access" };
  }
}

// Per-turn override needs the object-form SandboxPolicy (thread start takes the string form).
export function sandboxPolicyFor(sandbox: CodexSandboxMode): CodexSandboxPolicy {
  switch (sandbox) {
    case "read-only":
      return { type: "readOnly", networkAccess: false };
    case "workspace-write":
      return { type: "workspaceWrite", writableRoots: [], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
    case "danger-full-access":
      return { type: "dangerFullAccess" };
  }
}

// rookery effort vocab (low..max) → Codex ReasoningEffort (low..xhigh). `max` has no
// Codex analog → xhigh. Unknown/empty → undefined (omit → Codex model default).
export function mapEffort(effort: string | undefined): string | undefined {
  switch (effort) {
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return effort;
    case "max":
      return "xhigh";
    default:
      return undefined;
  }
}
