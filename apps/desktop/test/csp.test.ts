import { describe, it, expect } from "vitest";
import { buildCsp, isAllowedNavigation, decideWindowOpen } from "../src/main/csp.js";

describe("buildCsp", () => {
  it("PROD: file: workers, no unsafe-eval, daemon ws, strict base", () => {
    const csp = buildCsp({ isDev: false, host: "127.0.0.1" });
    expect(csp).toContain("script-src 'self' file: blob:");
    expect(csp).toContain("worker-src 'self' file: blob:");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("img-src 'self' data: blob:");
    expect(csp).toContain("font-src 'self' file:");
    expect(csp).toContain("connect-src 'self' ws://127.0.0.1:* ws://localhost:*");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain("http://localhost");
  });
  it("DEV: adds unsafe-eval + dev http/ws origins", () => {
    const csp = buildCsp({ isDev: true, host: "127.0.0.1" });
    expect(csp).toContain("'unsafe-eval'");
    expect(csp).toContain("http://localhost:* http://127.0.0.1:*");
    expect(csp).toContain("ws://localhost:* ws://127.0.0.1:*");
  });
  it("non-loopback ROOKERY_HOST is added to connect-src (additive, not replace)", () => {
    const csp = buildCsp({ isDev: false, host: "192.168.1.5" });
    expect(csp).toContain("ws://127.0.0.1:*"); // loopback pair kept
    expect(csp).toContain("ws://192.168.1.5:*"); // added
  });
});

describe("isAllowedNavigation", () => {
  it("PROD (no devUrl): only file://", () => {
    expect(isAllowedNavigation("file:///x/index.html", undefined)).toBe(true);
    expect(isAllowedNavigation("https://evil.com", undefined)).toBe(false);
    expect(isAllowedNavigation("http://localhost:5173", undefined)).toBe(false);
    expect(isAllowedNavigation("javascript:alert(1)", undefined)).toBe(false);
    expect(isAllowedNavigation("about:blank", undefined)).toBe(false);
  });
  it("DEV: only the exact dev-server origin (no prefix false-allow)", () => {
    const dev = "http://localhost:5173";
    expect(isAllowedNavigation("http://localhost:5173/foo", dev)).toBe(true);
    expect(isAllowedNavigation("http://localhost:51730", dev)).toBe(false); // prefix guard
    expect(isAllowedNavigation("http://localhost:5174", dev)).toBe(false);
    expect(isAllowedNavigation("https://evil.com", dev)).toBe(false);
    expect(isAllowedNavigation("file:///x", dev)).toBe(false);
    expect(isAllowedNavigation("not a url", dev)).toBe(false);
  });
});

describe("decideWindowOpen", () => {
  it("always deny; openExternal only for http(s)", () => {
    expect(decideWindowOpen("https://x.com")).toEqual({ action: "deny", openExternal: true });
    expect(decideWindowOpen("http://x.com")).toEqual({ action: "deny", openExternal: true });
    expect(decideWindowOpen("javascript:alert(1)")).toEqual({ action: "deny", openExternal: false });
    expect(decideWindowOpen("file:///x")).toEqual({ action: "deny", openExternal: false });
    expect(decideWindowOpen("mailto:a@b.c")).toEqual({ action: "deny", openExternal: false });
  });
});
