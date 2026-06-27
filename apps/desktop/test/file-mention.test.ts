import { describe, it, expect } from "vitest";
import { activeMentionQuery, splitPath, filterEntries, chipPathOf } from "../src/renderer/lib/file-mention.js";
import type { BrowseEntry } from "../src/renderer/types/rookery.js";

const f = (name: string, size = 0): BrowseEntry => ({ name, isDir: false, size });
const d = (name: string): BrowseEntry => ({ name, isDir: true });

describe("activeMentionQuery", () => {
  it("triggers on a bare @ at the start (empty query)", () => {
    expect(activeMentionQuery("@")).toEqual({ query: "", start: 0 });
  });
  it("extracts the path query after @ mid-text, with the @ index", () => {
    expect(activeMentionQuery("이거 @src")).toEqual({ query: "src", start: 3 });
  });
  it("keeps slashes in the query (path traversal)", () => {
    expect(activeMentionQuery("보고 @src/comp")).toEqual({ query: "src/comp", start: 3 });
  });
  it("uses the LAST @ when several are present", () => {
    expect(activeMentionQuery("@a.ts @comp")).toEqual({ query: "comp", start: 6 });
  });
  it("does NOT trigger when @ is glued to a preceding word (email)", () => {
    expect(activeMentionQuery("mail foo@bar")).toBeNull();
  });
  it("closes once whitespace follows the token (path done)", () => {
    expect(activeMentionQuery("@src ")).toBeNull();
  });
  it("returns null when there is no @", () => {
    expect(activeMentionQuery("hello world")).toBeNull();
  });
});

describe("splitPath", () => {
  it("splits dir prefix and filter on the last slash", () => {
    expect(splitPath("src/comp")).toEqual({ dirPart: "src/", filter: "comp" });
  });
  it("no slash → empty dir, whole thing is the filter", () => {
    expect(splitPath("comp")).toEqual({ dirPart: "", filter: "comp" });
  });
  it("empty query → empty dir and filter", () => {
    expect(splitPath("")).toEqual({ dirPart: "", filter: "" });
  });
  it("home prefix is kept in the dir part", () => {
    expect(splitPath("~/Doc")).toEqual({ dirPart: "~/", filter: "Doc" });
  });
  it("trailing slash → that dir, empty filter", () => {
    expect(splitPath("src/")).toEqual({ dirPart: "src/", filter: "" });
  });
  it("absolute path splits at the last slash", () => {
    expect(splitPath("/usr/lo")).toEqual({ dirPart: "/usr/", filter: "lo" });
  });
});

describe("filterEntries", () => {
  it("hides dotfiles unless the filter starts with a dot", () => {
    expect(filterEntries([f(".env", 4), f("app.ts"), d("src")], "")).toEqual([d("src"), f("app.ts")]);
  });
  it("shows dotfiles when the filter starts with a dot", () => {
    expect(filterEntries([f(".env", 4), f("app.ts"), d("src")], ".e")).toEqual([f(".env", 4)]);
  });
  it("matches as a case-insensitive substring", () => {
    expect(filterEntries([f("App.TS"), f("main.go")], "app")).toEqual([f("App.TS")]);
  });
  it("ranks prefix matches before mid-string matches", () => {
    expect(filterEntries([f("foo_index"), f("index_a"), f("index_b")], "index"))
      .toEqual([f("index_a"), f("index_b"), f("foo_index")]);
  });
  it("keeps directories ahead of files", () => {
    expect(filterEntries([f("zfile"), d("adir")], "")).toEqual([d("adir"), f("zfile")]);
  });
  it("caps the result list at 50", () => {
    const many = Array.from({ length: 60 }, (_, i) => f(`x${String(i).padStart(2, "0")}`));
    expect(filterEntries(many, "x")).toHaveLength(50);
  });
});

describe("chipPathOf", () => {
  it("joins resolved dir and name with a slash", () => {
    expect(chipPathOf("/r/src", "a.ts")).toBe("/r/src/a.ts");
  });
  it("does not double the slash at filesystem root", () => {
    expect(chipPathOf("/", "a.ts")).toBe("/a.ts");
  });
});
