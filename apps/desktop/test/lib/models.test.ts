import { describe, it, expect } from "vitest";
import { EFFORTS, effortLabelKey, codexEffortsFor, codexDefaultEffort, effectiveEffort } from "../../src/renderer/lib/models.js";
import { catalogs } from "../../src/renderer/i18n/catalog.js";
import type { CodexModelInfo } from "@daemon/protocol/messages.js";

describe("effortLabelKey", () => {
  it("maps each raw effort token to its common.effort* display-label key", () => {
    expect(effortLabelKey("low")).toBe("common.effortLow");
    expect(effortLabelKey("medium")).toBe("common.effortMedium");
    expect(effortLabelKey("high")).toBe("common.effortHigh");
    expect(effortLabelKey("xhigh")).toBe("common.effortXhigh");
    expect(effortLabelKey("max")).toBe("common.effortMax");
  });

  it("every EFFORTS token resolves to a real key in both locale catalogs (no raw token ever reaches the UI)", () => {
    for (const ef of EFFORTS) {
      const key = effortLabelKey(ef);
      expect(catalogs.ko).toHaveProperty(key);
      expect(catalogs.en).toHaveProperty(key);
      // The label must not just echo the raw machine token back (audit #33's "xhigh" leak).
      expect(catalogs.ko[key as keyof typeof catalogs.ko]).not.toBe(ef);
      expect(catalogs.en[key as keyof typeof catalogs.en]).not.toBe(ef);
    }
  });
});

const CODEX_MODELS_FIXTURE: CodexModelInfo[] = [
  { id: "gpt-5.5", displayName: "GPT-5.5", defaultEffort: "xhigh", supportedEfforts: ["low", "medium", "high", "xhigh"], isDefault: true },
  { id: "gpt-5.4", displayName: "GPT-5.4", defaultEffort: "medium", supportedEfforts: ["low", "medium", "high"], isDefault: false },
  { id: "gpt-5.4-mini", displayName: "GPT-5.4 Mini", defaultEffort: "", supportedEfforts: [], isDefault: false },
];

describe("codexEffortsFor", () => {
  it("returns the matching model's supportedEfforts", () => {
    expect(codexEffortsFor("gpt-5.5", CODEX_MODELS_FIXTURE)).toEqual(["low", "medium", "high", "xhigh"]);
    expect(codexEffortsFor("gpt-5.4", CODEX_MODELS_FIXTURE)).toEqual(["low", "medium", "high"]);
  });

  it("returns [] for an unknown model", () => {
    expect(codexEffortsFor("no-such-model", CODEX_MODELS_FIXTURE)).toEqual([]);
  });

  it("returns [] when list is null (couldn't fetch)", () => {
    expect(codexEffortsFor("gpt-5.5", null)).toEqual([]);
  });
});

describe("codexDefaultEffort", () => {
  it("returns the matching model's defaultEffort", () => {
    expect(codexDefaultEffort("gpt-5.5", CODEX_MODELS_FIXTURE)).toBe("xhigh");
    expect(codexDefaultEffort("gpt-5.4", CODEX_MODELS_FIXTURE)).toBe("medium");
  });

  it("returns undefined for an unknown model", () => {
    expect(codexDefaultEffort("no-such-model", CODEX_MODELS_FIXTURE)).toBeUndefined();
  });

  it("returns undefined when list is null", () => {
    expect(codexDefaultEffort("gpt-5.5", null)).toBeUndefined();
  });

  it("returns undefined when the model's defaultEffort is empty string (the || undefined guard)", () => {
    expect(codexDefaultEffort("gpt-5.4-mini", CODEX_MODELS_FIXTURE)).toBeUndefined();
  });
});

// The single source of truth for "the effort actually in play" — derived at render time (no effect-syncing).
// Every effort surface (master composer via App.tsx masterControls, WorkerSpawnModal, NewSessionPage) resolves
// through this, so a Claude-vocab level (e.g. 'max') can never render blank or be submitted on a codex model.
describe("effectiveEffort", () => {
  it("passes the choice through for claude (any vocab, including 'max')", () => {
    expect(effectiveEffort("claude", "claude-opus-4-8", "max", CODEX_MODELS_FIXTURE)).toBe("max");
  });

  it("passes the choice through for codex when the catalog is null (free-text / generic vocab)", () => {
    expect(effectiveEffort("codex", "gpt-5.5", "max", null)).toBe("max");
  });

  it("passes the choice through for a codex model that has no catalog efforts", () => {
    expect(effectiveEffort("codex", "gpt-5.4-mini", "max", CODEX_MODELS_FIXTURE)).toBe("max"); // supportedEfforts []
  });

  it("keeps a codex choice that is valid for the model", () => {
    expect(effectiveEffort("codex", "gpt-5.5", "high", CODEX_MODELS_FIXTURE)).toBe("high");
  });

  it("re-derives an invalid codex choice to the model's default effort", () => {
    expect(effectiveEffort("codex", "gpt-5.5", "max", CODEX_MODELS_FIXTURE)).toBe("xhigh"); // 'max' not supported → gpt-5.5 default
    expect(effectiveEffort("codex", "gpt-5.4", "xhigh", CODEX_MODELS_FIXTURE)).toBe("medium"); // 'xhigh' not in gpt-5.4 → its default
  });

  it("falls back to the first supported effort when the model has no default effort", () => {
    const model: CodexModelInfo = { id: "gpt-x", displayName: "X", defaultEffort: "", supportedEfforts: ["low", "medium"], isDefault: false };
    expect(effectiveEffort("codex", "gpt-x", "max", [model])).toBe("low");
  });
});
