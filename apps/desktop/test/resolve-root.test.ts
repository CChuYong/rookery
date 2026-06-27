import { describe, it, expect } from "vitest";
import { resolveWorkRoot } from "../src/main/resolve-root.js";

const deps = {
  rookeryHome: "/home/me/.rookery",
  homeDir: "/home/me",
  exists: (p: string) => p === "/code/app" || p.startsWith("/home/me/.rookery/worktrees/live"),
};

describe("resolveWorkRoot", () => {
  it("prefers an existing sub worktree", () => {
    expect(resolveWorkRoot(deps, { subId: "live1", cwd: "/code/app" })).toBe("/home/me/.rookery/worktrees/live1");
  });
  it("falls back to cwd when the worktree is gone", () => {
    expect(resolveWorkRoot(deps, { subId: "gone", cwd: "/code/app" })).toBe("/code/app");
  });
  it("falls back to home when cwd does not exist", () => {
    expect(resolveWorkRoot(deps, { cwd: "/nope" })).toBe("/home/me");
  });
});
