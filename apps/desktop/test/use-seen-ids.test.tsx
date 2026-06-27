import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useSeenIds } from "../src/renderer/lib/useSeenIds.js";

describe("useSeenIds (list-insert entrance gate)", () => {
  it("returns true the first time an id is seen, false afterwards", () => {
    const { result } = renderHook(() => useSeenIds());
    const isNew = result.current;
    expect(isNew("a")).toBe(true);
    expect(isNew("a")).toBe(false);
    expect(isNew("a")).toBe(false);
  });

  it("tracks each id independently", () => {
    const { result } = renderHook(() => useSeenIds());
    const isNew = result.current;
    expect(isNew("a")).toBe(true);
    expect(isNew("b")).toBe(true);
    expect(isNew("a")).toBe(false);
    expect(isNew("b")).toBe(false);
    expect(isNew("c")).toBe(true);
  });

  it("keeps a stable function identity across rerenders so seen-state persists", () => {
    const { result, rerender } = renderHook(() => useSeenIds());
    const first = result.current;
    expect(first("a")).toBe(true);
    rerender();
    const second = result.current;
    expect(second).toBe(first); // stable identity
    expect(second("a")).toBe(false); // remembers across renders
  });

  it("seeding ids up front suppresses their entrance (replay-mount guard)", () => {
    const { result } = renderHook(() => useSeenIds(["x", "y"]));
    const isNew = result.current;
    expect(isNew("x")).toBe(false);
    expect(isNew("y")).toBe(false);
    expect(isNew("z")).toBe(true);
  });
});
