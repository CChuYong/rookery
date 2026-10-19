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

// rookery effort vocab → Codex ReasoningEffort. Since the model/list catalog advertises
// low/medium/high/xhigh/max/ultra per model (CLI 0.163.0) and the desktop picker is catalog-driven,
// every level is already model-valid and passes through unchanged (`max`/`ultra` used to be
// downgraded). Unknown/empty → undefined (omit → Codex model default). Claude's effort vocabulary
// (src/core/effort.ts) is deliberately NOT widened: `ultra` is Codex-only.
export function mapEffort(effort: string | undefined): string | undefined {
  switch (effort) {
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
    case "ultra":
      return effort;
    default:
      return undefined;
  }
}
