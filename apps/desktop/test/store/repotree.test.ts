import { describe, it, expect, beforeEach, vi } from "vitest";
import { useRepoTreeStore } from "../../src/renderer/store/repotree.js";

// Fold state for the RepoTree sidebar. It must live OUTSIDE the component (persisted) because the
// sidebar conditionally renders RepoTree vs Sessions — every tab switch unmounts the tree, and
// component-local state would snap every repo back to "expanded" (and again on app restart).
describe("repotree fold store", () => {
  beforeEach(() => {
    localStorage.clear();
    useRepoTreeStore.setState({ collapsed: {}, archOpen: false });
  });

  it("setCollapsed(true) records the key and persists to rookery.repotree", () => {
    useRepoTreeStore.getState().setCollapsed("app", true);
    expect(useRepoTreeStore.getState().collapsed["app"]).toBe(true);
    expect(localStorage.getItem("rookery.repotree")).toContain('"app":true');
  });

  it("setCollapsed(false) drops the key instead of storing false (expanded is the default)", () => {
    useRepoTreeStore.getState().setCollapsed("app", true);
    useRepoTreeStore.getState().setCollapsed("app", false);
    expect(useRepoTreeStore.getState().collapsed).toEqual({});
  });

  it("setArchOpen updates and persists", () => {
    useRepoTreeStore.getState().setArchOpen(true);
    expect(useRepoTreeStore.getState().archOpen).toBe(true);
    expect(localStorage.getItem("rookery.repotree")).toContain('"archOpen":true');
  });

  it("prune drops keys whose repo no longer exists and keeps valid ones", () => {
    useRepoTreeStore.getState().setCollapsed("app", true);
    useRepoTreeStore.getState().setCollapsed("removed-repo", true);
    useRepoTreeStore.getState().prune(new Set(["app", "__orphans__"]));
    expect(useRepoTreeStore.getState().collapsed).toEqual({ app: true });
  });

  it("prune is a no-op (same reference) when nothing is stale", () => {
    useRepoTreeStore.getState().setCollapsed("app", true);
    const before = useRepoTreeStore.getState().collapsed;
    useRepoTreeStore.getState().prune(new Set(["app"]));
    expect(useRepoTreeStore.getState().collapsed).toBe(before);
  });

  it("rehydrates saved fold state on a fresh module load (app restart)", async () => {
    localStorage.setItem("rookery.repotree", JSON.stringify({ state: { collapsed: { app: true }, archOpen: true }, version: 1 }));
    vi.resetModules();
    const { useRepoTreeStore: fresh } = await import("../../src/renderer/store/repotree.js");
    expect(fresh.getState().collapsed).toEqual({ app: true });
    expect(fresh.getState().archOpen).toBe(true);
  });
});
