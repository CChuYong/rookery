import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTreeVersion } from "../src/renderer/lib/useTreeVersion.js";

let treeCb: ((root: string) => void) | null = null;
const watchTree = vi.fn();
const unwatchTree = vi.fn();
const off = vi.fn();

beforeEach(() => {
  treeCb = null; watchTree.mockClear(); unwatchTree.mockClear(); off.mockClear();
  (globalThis as any).window = (globalThis as any).window ?? {};
  (window as any).rookery = { ws: {
    watchTree, unwatchTree,
    onTree: (cb: (root: string) => void) => { treeCb = cb; return off; },
  } };
});

describe("useTreeVersion", () => {
  it("watches the root, bumps version on matching fs:tree, ignores other roots", () => {
    const { result, rerender } = renderHook(({ root }) => useTreeVersion(root), { initialProps: { root: "/r" as string | null } });
    expect(watchTree).toHaveBeenCalledWith("/r");
    expect(result.current).toBe(0);
    act(() => treeCb!("/other")); // different root → ignored
    expect(result.current).toBe(0);
    act(() => treeCb!("/r")); // my root → increment
    expect(result.current).toBe(1);
    rerender({ root: null }); // cleanup
    expect(unwatchTree).toHaveBeenCalledWith("/r");
    expect(off).toHaveBeenCalled();
  });
});
