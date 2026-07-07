import type { CodexModelInfo } from "@daemon/protocol/messages.js";
import { effectiveEffort } from "./models.js";

// The master composer's model/effort/permission-mode VALUES, resolved as a pure function of the session's
// provider, the per-session override, the settings defaults, and the codex catalog. App.tsx's masterControls
// spreads this and adds the (store-mutating) onModel/onEffort/onPermissionMode handlers. Kept pure + here so
// the codex-awareness (provider-defaulted model, effort re-derivation, bypass-only mode list) is unit-tested
// rather than living untested inline in the App component.
export interface MasterControlValues {
  provider: string | undefined;
  model: string;
  effort: string;
  permissionMode: string;
  permissionModes?: readonly string[];
}

export function resolveMasterControls(args: {
  provider: string | undefined;
  override: { model?: string; effort?: string; permissionMode?: string } | undefined;
  masterModel: string;
  codexMasterModel: string;
  masterEffort: string;
  codexModels: CodexModelInfo[] | null;
}): MasterControlValues {
  const { provider, override, masterModel, codexMasterModel, masterEffort, codexModels } = args;
  const isCodex = provider === "codex";
  const defaultModel = isCodex ? codexMasterModel : masterModel;
  // A codex session defaults to codexMasterModel, not the Claude masterModel — otherwise the composer shows a
  // Claude id the codex-aware dropdown has no option for. The override (explicit user pick) always wins.
  const model = override?.model ?? defaultModel;
  // Effort is resolved against the model the DAEMON will actually run — an override of "" ("use default")
  // trims to the provider default (mirroring the daemon's `override?.model?.trim() || deps.model()`), so the
  // effort is valid for the real model, not derived off an empty id.
  const effortModel = override?.model?.trim() || defaultModel;
  return {
    provider,
    model,
    // Resolve the effort actually in play so a codex session never shows/sends a Claude-vocab level (e.g. the
    // masterEffort default 'max') its model has no equivalent for — it re-derives to the model's catalog
    // default (finding [23]). The stored override is untouched; a claude session passes its choice through.
    effort: effectiveEffort(provider ?? "claude", effortModel, override?.effort ?? masterEffort, codexModels),
    permissionMode: override?.permissionMode ?? "bypassPermissions",
    // Codex masters are bypassPermissions-only (the daemon rejects any other mode at turn start), so a codex
    // session's composer must offer ONLY bypass (finding [2]); claude omits the key → Composer shows all four.
    ...(isCodex ? { permissionModes: ["bypassPermissions"] as const } : {}),
  };
}
