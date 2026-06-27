import { describe, it, expect, beforeEach } from "vitest";
import { setMainLocale, mt } from "../../src/main/i18n.js";

describe("main i18n", () => {
  beforeEach(() => setMainLocale("en"));
  it("defaults to en and interpolates", () => {
    expect(mt("terminal.tooMany", { max: 8 })).toBe("You can open up to 8 terminals per session.");
  });
  it("switches to ko on a ko* locale", () => {
    setMainLocale("ko-KR");
    expect(mt("terminal.tooMany", { max: 8 })).toBe("터미널은 세션당 최대 8개까지 열 수 있어요.");
  });
});
