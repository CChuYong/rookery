import { describe, it, expect } from "vitest";
import { resolveMasterControls } from "../../src/renderer/lib/master-controls.js";
import type { CodexModelInfo } from "@daemon/protocol/messages.js";

const CODEX: CodexModelInfo[] = [
  { id: "gpt-5.5", displayName: "GPT-5.5", defaultEffort: "xhigh", supportedEfforts: ["low", "medium", "high", "xhigh"], isDefault: true },
];
const SETTINGS = { masterModel: "claude-opus-4-8", codexMasterModel: "gpt-5.5", masterEffort: "max" };

describe("resolveMasterControls", () => {
  it("claude session: Claude model/effort defaults, no permissionModes restriction (composer shows all four)", () => {
    const v = resolveMasterControls({ provider: "claude", override: undefined, ...SETTINGS, codexModels: CODEX });
    expect(v.model).toBe("claude-opus-4-8");
    expect(v.effort).toBe("max"); // Claude passes its vocabulary through
    expect(v.permissionMode).toBe("bypassPermissions");
    expect(v.permissionModes).toBeUndefined();
  });

  it("codex session: codex default model, effort re-derived off the catalog (masterEffort 'max' → gpt-5.5 default), bypass-only modes (findings [23]/[2])", () => {
    const v = resolveMasterControls({ provider: "codex", override: undefined, ...SETTINGS, codexModels: CODEX });
    expect(v.model).toBe("gpt-5.5");
    expect(v.effort).toBe("xhigh"); // 'max' isn't a gpt-5.5 level → its catalog default, NOT a blank/stale 'max'
    expect(v.permissionModes).toEqual(["bypassPermissions"]);
  });

  it("codex session with a null catalog: effort passes through (free-text fallback), model is the codex default", () => {
    const v = resolveMasterControls({ provider: "codex", override: undefined, ...SETTINGS, codexModels: null });
    expect(v.model).toBe("gpt-5.5");
    expect(v.effort).toBe("max"); // no catalog to clamp against → generic vocab, unchanged
  });

  it("resolves effort against the DEFAULT model when the model override is the empty 'use default' pick", () => {
    // ov.model="" ("use default") + masterEffort 'max' must derive off codexMasterModel (gpt-5.5), not off ""
    // (which would passthrough 'max' and diverge from what the daemon actually runs).
    const v = resolveMasterControls({ provider: "codex", override: { model: "" }, ...SETTINGS, codexModels: CODEX });
    expect(v.model).toBe(""); // display keeps the "use default" option
    expect(v.effort).toBe("xhigh"); // effort resolved for the real default model gpt-5.5, not blank/'max'
  });

  it("an explicit override wins for model/effort/permissionMode, but an invalid codex effort override is still re-derived", () => {
    const v = resolveMasterControls({
      provider: "codex",
      override: { model: "gpt-5.5", effort: "high", permissionMode: "bypassPermissions" },
      ...SETTINGS,
      codexModels: CODEX,
    });
    expect(v.model).toBe("gpt-5.5");
    expect(v.effort).toBe("high"); // a valid codex level is kept verbatim
    // and an invalid override effort is clamped, not shown blank:
    const bad = resolveMasterControls({ provider: "codex", override: { effort: "max" }, ...SETTINGS, codexModels: CODEX });
    expect(bad.effort).toBe("xhigh");
  });
});
