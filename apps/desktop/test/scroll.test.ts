import { describe, it, expect, vi, afterEach } from "vitest";
import { scrollToBottom } from "../src/renderer/lib/scroll.js";

function fakeEl(scrollHeight = 1234): { el: HTMLElement; calls: ScrollToOptions[] } {
  const calls: ScrollToOptions[] = [];
  const el = {
    scrollHeight,
    scrollTop: 0,
    scrollTo: (opts: ScrollToOptions) => { calls.push(opts); },
  } as unknown as HTMLElement;
  return { el, calls };
}

function mockReducedMotion(reduce: boolean): void {
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: reduce && q.includes("reduce"),
    media: q,
    addEventListener() {},
    removeEventListener() {},
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe("scrollToBottom", () => {
  it("uses smooth behavior when reduced-motion is not preferred", () => {
    mockReducedMotion(false);
    const { el, calls } = fakeEl();
    scrollToBottom(el);
    expect(calls).toEqual([{ top: 1234, behavior: "smooth" }]);
  });

  it("uses instant ('auto') behavior under prefers-reduced-motion", () => {
    mockReducedMotion(true);
    const { el, calls } = fakeEl();
    scrollToBottom(el);
    expect(calls).toEqual([{ top: 1234, behavior: "auto" }]);
  });

  it("falls back to scrollTop assignment when scrollTo is unavailable", () => {
    mockReducedMotion(false);
    const el = { scrollHeight: 999, scrollTop: 0 } as unknown as HTMLElement;
    expect(() => scrollToBottom(el)).not.toThrow();
    expect(el.scrollTop).toBe(999);
  });
});
