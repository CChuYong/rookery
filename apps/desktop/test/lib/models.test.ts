import { describe, it, expect } from "vitest";
import { EFFORTS, effortLabelKey } from "../../src/renderer/lib/models.js";
import { catalogs } from "../../src/renderer/i18n/catalog.js";

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
