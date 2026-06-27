import { describe, it, expect } from "vitest";
import { catalogs } from "../../src/renderer/i18n/catalog.js";

// Collect t("ns.key") / tRef.current("ns.key") literal keys from the renderer sources
// and assert they all exist in the ko catalog (guards against typo/missing keys that typechecking can't catch).
const sources = import.meta.glob("../../src/renderer/**/*.{ts,tsx}", { eager: true, query: "?raw", import: "default" }) as Record<string, string>;

const KEY_CALL = /\bt(?:Ref\.current)?\(\s*["']([A-Za-z0-9_]+\.[A-Za-z0-9_]+)["']/g;

describe("i18n used keys exist in catalog", () => {
  it("every literal t(...) key resolves in the ko catalog", () => {
    const missing: Array<{ file: string; key: string }> = [];
    for (const [file, src] of Object.entries(sources)) {
      if (file.includes("/i18n/")) continue; // exclude catalog/provider internals
      for (const m of src.matchAll(KEY_CALL)) {
        const key = m[1]!;
        if (!(key in catalogs.ko)) missing.push({ file, key });
      }
    }
    expect(missing).toEqual([]);
  });
});
