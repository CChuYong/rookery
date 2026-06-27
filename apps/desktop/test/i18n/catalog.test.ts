import { describe, it, expect } from "vitest";
import { catalogs } from "../../src/renderer/i18n/catalog.js";

describe("i18n catalogs", () => {
  it("ko and en expose the identical key set (no missing translation)", () => {
    const ko = Object.keys(catalogs.ko).sort();
    const en = Object.keys(catalogs.en).sort();
    expect(en).toEqual(ko);
  });
  it("no namespace key collides on merge (file count sum == merged count)", () => {
    const koMods = import.meta.glob<{ default: Record<string, string> }>("../../src/renderer/i18n/locales/ko/*.ts", { eager: true });
    const sum = Object.values(koMods).reduce((n, m) => n + Object.keys(m.default).length, 0);
    expect(Object.keys(catalogs.ko).length).toBe(sum);
  });
  it("has the common namespace seeded", () => {
    expect(catalogs.ko["common.save"]).toBe("저장");
    expect(catalogs.en["common.save"]).toBe("Save");
  });
});
