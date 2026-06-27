import { describe, it, expect, vi } from "vitest";
import { fetchGitHubItem, searchGitHubIssues, searchGitHubItems, githubAuthStatus } from "../../src/core/source-intake.js";

describe("fetchGitHubItem", () => {
  it("parses an issue URL and calls gh issue view with -R owner/repo", async () => {
    const calls: string[] = [];
    const exec = async (_cmd: string, args: string[]) => {
      calls.push(args.join(" "));
      return JSON.stringify({ title: "Fix bug", body: "details" });
    };
    const r = await fetchGitHubItem("https://github.com/octo/repo/issues/42", exec);
    expect(r).toEqual({ title: "Fix bug", body: "details" });
    expect(calls[0]).toBe("issue view 42 -R octo/repo --json title,body");
  });

  it("parses a PR URL → pr view", async () => {
    const calls: string[] = [];
    const exec = async (_c: string, args: string[]) => { calls.push(args.join(" ")); return JSON.stringify({ title: "PR", body: "" }); };
    await fetchGitHubItem("https://github.com/o/r/pull/7", exec);
    expect(calls[0]).toBe("pr view 7 -R o/r --json title,body");
  });

  it("returns null for a non-GitHub URL without calling exec", async () => {
    let called = false;
    const exec = async () => { called = true; return ""; };
    expect(await fetchGitHubItem("https://example.com/x", exec)).toBeNull();
    expect(called).toBe(false);
  });

  it("returns null when exec throws (gh missing/unauthed) — best-effort", async () => {
    const exec = async () => { throw new Error("gh: command not found"); };
    expect(await fetchGitHubItem("https://github.com/o/r/issues/1", exec)).toBeNull();
  });
});

describe("searchGitHubIssues", () => {
  it("runs gh issue list in the repo cwd and maps rows", async () => {
    const exec = vi.fn(async () => JSON.stringify([
      { number: 12, title: "Fix login", url: "https://github.com/o/r/issues/12", body: "redirect bug", state: "OPEN" },
    ]));
    const items = await searchGitHubIssues("/repo/path", "login", exec);
    expect(exec).toHaveBeenCalledWith("gh",
      ["issue", "list", "--json", "number,title,url,body,state", "--limit", "20", "--search", "login"],
      { cwd: "/repo/path" });
    expect(items).toEqual([{ provider: "github", id: "12", identifier: "#12", title: "Fix login", url: "https://github.com/o/r/issues/12", body: "redirect bug", state: "open" }]);
  });

  it("omits --search for an empty query", async () => {
    const exec = vi.fn(async () => "[]");
    await searchGitHubIssues("/repo", "  ", exec);
    expect(exec).toHaveBeenCalledWith("gh", ["issue", "list", "--json", "number,title,url,body,state", "--limit", "20"], { cwd: "/repo" });
  });

  it("returns [] when gh fails", async () => {
    const exec = vi.fn(async () => { throw new Error("gh missing"); });
    expect(await searchGitHubIssues("/repo", "x", exec)).toEqual([]);
  });
});

describe("searchGitHubItems (issues + PRs)", () => {
  it("merges issues and PRs, sorted by number desc", async () => {
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "issue") return JSON.stringify([{ number: 12, title: "Issue A", url: "https://g/12", body: "ib", state: "OPEN" }]);
      return JSON.stringify([{ number: 15, title: "PR B", url: "https://g/15", body: "pb", state: "OPEN" }]);
    });
    const items = await searchGitHubItems("/repo", "x", exec);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(items.map((i) => i.identifier)).toEqual(["#15", "#12"]);
    expect(items[0]).toMatchObject({ provider: "github", title: "PR B", url: "https://g/15", body: "pb" });
  });

  it("tolerates one side failing", async () => {
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "pr") throw new Error("no prs");
      return JSON.stringify([{ number: 3, title: "only issue", url: "https://g/3", body: "", state: "CLOSED" }]);
    });
    const items = await searchGitHubItems("/repo", "", exec);
    expect(items.map((i) => i.identifier)).toEqual(["#3"]);
  });
});

describe("githubAuthStatus", () => {
  it("reports available + parses account", async () => {
    const exec = vi.fn(async () => "github.com\n  ✓ Logged in to github.com account octocat (keyring)");
    expect(await githubAuthStatus(exec)).toEqual({ available: true, user: "octocat" });
  });
  it("reports unavailable when gh throws", async () => {
    const exec = vi.fn(async () => { throw new Error("not logged in"); });
    expect(await githubAuthStatus(exec)).toEqual({ available: false });
  });
});
