import { describe, it, expect } from "vitest";
import { t, resolveLocale, DEFAULT_LOCALE, KO, EN } from "../../src/core/i18n.js";

describe("daemon i18n", () => {
  it("ko and en expose the identical key set", () => {
    expect(Object.keys(EN).sort()).toEqual(Object.keys(KO).sort());
  });

  it("DEFAULT_LOCALE is Korean", () => {
    expect(DEFAULT_LOCALE).toBe("ko");
  });

  it("resolveLocale: ko-ish → ko, everything else → en, empty → ko", () => {
    expect(resolveLocale("ko")).toBe("ko");
    expect(resolveLocale("ko-KR")).toBe("ko");
    expect(resolveLocale("en")).toBe("en");
    expect(resolveLocale("en-US")).toBe("en");
    expect(resolveLocale("")).toBe("ko");
    expect(resolveLocale(undefined)).toBe("ko");
    expect(resolveLocale(null)).toBe("ko");
  });

  it("slack greeting interpolates the agent name (masterName surfaces)", () => {
    expect(t("ko", "slack.greeting", { name: "제니" })).toBe("안녕하세요! 제니입니다. 무엇을 도와드릴까요?");
    expect(t("en", "slack.greeting", { name: "Jenny" })).toBe("Hi! I'm Jenny. How can I help?");
  });

  it("t interpolates {param} and leaves unknown params as literal", () => {
    expect(t("ko", "notice.memoryRecall", { count: 2 })).toBe("🧠 기억 2개 참조");
    expect(t("en", "notice.memoryRecall", { count: 2 })).toBe("🧠 Recalled 2 memories");
    expect(t("ko", "notice.requiresAction")).toBe("⏸ 입력/승인 필요");
  });

  it("compact notice renders span/trigger params in both locales", () => {
    expect(t("ko", "notice.compact", { trigger: "auto", span: "84k→12k" })).toContain("84k→12k");
    expect(t("en", "notice.compact", { trigger: "auto", span: "84k→12k" })).toContain("Context compacted");
  });
});
