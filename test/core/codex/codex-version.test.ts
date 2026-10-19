import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseCodexVersion, compareVersions, evaluateInitialize, initializeCodex, CodexVersionError, MIN_CODEX_VERSION, EXCLUDE_TURNS_MIN_VERSION, __resetCodexVersionWarningForTests } from "../../../src/core/codex/codex-version.js";

const ua = (v: string) => ({ userAgent: `rookery/${v} (Mac OS 15.7.3; arm64) iTerm.app/3.6.9 (rookery; 0.1.0)` });

describe("codex version policy", () => {
  beforeEach(() => __resetCodexVersionWarningForTests());

  it("parses the live userAgent format and rejects junk", () => {
    expect(parseCodexVersion(ua("0.163.0").userAgent)).toEqual({ version: [0, 163, 0], prerelease: false });
    expect(parseCodexVersion("rookery/0.146.1-alpha.3 (x)")).toEqual({ version: [0, 146, 1], prerelease: true });
    expect(parseCodexVersion("rookery/0.146.1+build5 (x)")).toEqual({ version: [0, 146, 1], prerelease: false });
    expect(parseCodexVersion("codex_cli_rs/1.2.3")).toEqual({ version: [1, 2, 3], prerelease: false });
    // source/dev builds report the placeholder 0.0.0 → unknown
    expect(parseCodexVersion("rookery/0.0.0 (Mac OS 15.7.3; arm64) iTerm.app (rookery; 0.1.0)")).toBeNull();
    for (const bad of [undefined, null, 5, "", "rookery", "rookery/abc", "0.163.0"]) expect(parseCodexVersion(bad)).toBeNull();
  });

  it("compares numerically, not lexically", () => {
    expect(compareVersions([0, 146, 1], [0, 151, 0])).toBe(-1);
    expect(compareVersions([0, 9, 0], [0, 10, 0])).toBe(-1);
    expect(compareVersions([0, 163, 0], [0, 163, 0])).toBe(0);
    expect(compareVersions([1, 0, 0], [0, 999, 9])).toBe(1);
  });

  it("accepts the minimum, gates excludeTurns on 0.151.0, rejects older", () => {
    expect(evaluateInitialize(ua("0.146.1"))).toEqual({ version: MIN_CODEX_VERSION, supportsExcludeTurns: false });
    expect(evaluateInitialize(ua("0.150.1")).supportsExcludeTurns).toBe(false);
    expect(evaluateInitialize(ua("0.151.0"))).toEqual({ version: EXCLUDE_TURNS_MIN_VERSION, supportsExcludeTurns: true });
    expect(evaluateInitialize(ua("0.163.0")).supportsExcludeTurns).toBe(true);
    expect(() => evaluateInitialize(ua("0.146.0"))).toThrow(CodexVersionError);
    expect(() => evaluateInitialize(ua("0.144.1"))).toThrow(/0\.146\.1/);
  });

  it("feature gate is strict semver (0.151.0-alpha < 0.151.0) while the min check is lenient", () => {
    expect(evaluateInitialize(ua("0.151.0-alpha.4")).supportsExcludeTurns).toBe(false);
    expect(evaluateInitialize(ua("0.151.1-alpha.1")).supportsExcludeTurns).toBe(true);
    expect(evaluateInitialize(ua("0.152.0-rc.1")).supportsExcludeTurns).toBe(true);
    // pre-release of the minimum is NOT rejected
    expect(evaluateInitialize(ua("0.146.1-alpha.3"))).toMatchObject({ version: [0, 146, 1], supportsExcludeTurns: false });
  });

  it("treats the 0.0.0 dev-build placeholder as unknown: allowed (warned), excludeTurns off", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(evaluateInitialize(ua("0.0.0"))).toEqual({ version: null, supportsExcludeTurns: false });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("allows an unparseable version (warns once) without excludeTurns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(evaluateInitialize({})).toEqual({ version: null, supportsExcludeTurns: false });
    expect(evaluateInitialize(undefined).supportsExcludeTurns).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("initializeCodex sends the handshake, then initialized only on an accepted version", async () => {
    const calls: string[] = [];
    const client = {
      request: async (m: string) => { calls.push(m); return ua("0.144.1"); },
      notify: (m: string) => { calls.push(`notify:${m}`); },
    };
    await expect(initializeCodex(client as never, { name: "rookery", title: "rookery", version: "0.1.0" })).rejects.toThrow(CodexVersionError);
    expect(calls).toEqual(["initialize"]);
  });
});
