import { describe, it, expect } from "vitest";
import { resolveLocale } from "../../src/renderer/i18n/resolve.js";

describe("resolveLocale", () => {
  it("explicit pref wins over system", () => {
    expect(resolveLocale("ko", "en-US")).toBe("ko");
    expect(resolveLocale("en", "ko-KR")).toBe("en");
  });
  it("system maps ko* to ko, everything else to en", () => {
    expect(resolveLocale("system", "ko-KR")).toBe("ko");
    expect(resolveLocale("system", "ko")).toBe("ko");
    expect(resolveLocale("system", "en-GB")).toBe("en");
    expect(resolveLocale("system", "ja-JP")).toBe("en");
    expect(resolveLocale("system", "")).toBe("en");
  });
});
