import { describe, it, expect } from "vitest";
import { withResolvedPath } from "../src/main/resolve-path.js";

// Finding [3]: a Finder/LaunchServices-launched .app inherits launchd's minimal PATH, so a bare `codex`
// (the settings default) ENOENTs on every codex spawn. withResolvedPath merges the well-known CLI install
// dirs onto PATH for the daemon child (which the codex/gh grandchildren inherit).
describe("withResolvedPath (daemon child PATH — codex ENOENT fix)", () => {
  it("appends common CLI install dirs to a minimal launchd PATH so codex/gh can resolve", () => {
    const out = withResolvedPath({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: "/Users/x" }, "darwin", "/Users/x");
    const dirs = (out.PATH ?? "").split(":");
    expect(dirs).toContain("/opt/homebrew/bin");
    expect(dirs).toContain("/usr/local/bin");
    expect(dirs).toContain("/Users/x/.local/bin");
    expect(dirs[0]).toBe("/usr/bin"); // existing entries kept first — extras appended, never shadowing system binaries
  });

  it("does not duplicate a dir already on PATH", () => {
    const out = withResolvedPath({ PATH: "/opt/homebrew/bin:/usr/bin", HOME: "/Users/x" }, "darwin", "/Users/x");
    const dirs = (out.PATH ?? "").split(":");
    expect(dirs.filter((d) => d === "/opt/homebrew/bin")).toHaveLength(1);
  });

  it("is a no-op on win32 (returns the same env object)", () => {
    const env = { PATH: "C:\\Windows\\System32" };
    expect(withResolvedPath(env, "win32")).toBe(env);
  });

  it("preserves other env vars", () => {
    const out = withResolvedPath({ PATH: "/bin", HOME: "/h", FOO: "bar" }, "darwin", "/h");
    expect(out.FOO).toBe("bar");
  });
});
