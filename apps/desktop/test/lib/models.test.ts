import { describe, it, expect } from "vitest";
import { EFFORTS, effortLabelKey, codexEffortsFor, codexDefaultEffort } from "../../src/renderer/lib/models.js";
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
