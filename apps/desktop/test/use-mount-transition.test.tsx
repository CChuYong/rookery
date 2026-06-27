import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useMountTransition } from "../src/renderer/lib/useMountTransition.js";

function mockReducedMotion(reduce: boolean): void {
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: reduce && q.includes("reduce"),
    media: q,
    addEventListener() {},
    removeEventListener() {},
  }));
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("useMountTransition (defer unmount so exit can animate)", () => {
  it("is mounted while open", () => {
    mockReducedMotion(false);
    const { result } = renderHook(({ open }) => useMountTransition(open, 180), { initialProps: { open: true } });
    expect(result.current).toBe(true);
  });

  it("stays mounted through the exit delay, then unmounts", () => {
    vi.useFakeTimers();
    mockReducedMotion(false);
    const { result, rerender } = renderHook(({ open }) => useMountTransition(open, 180), { initialProps: { open: true } });
    rerender({ open: false });
    expect(result.current).toBe(true); // still mounted → exit can play
    act(() => vi.advanceTimersByTime(180));
    expect(result.current).toBe(false);
  });

  it("unmounts immediately under prefers-reduced-motion", () => {
    vi.useFakeTimers();
    mockReducedMotion(true);
    const { result, rerender } = renderHook(({ open }) => useMountTransition(open, 180), { initialProps: { open: true } });
    rerender({ open: false });
    expect(result.current).toBe(false);
  });

  it("re-mounts immediately when reopened during the exit window", () => {
    vi.useFakeTimers();
    mockReducedMotion(false);
    const { result, rerender } = renderHook(({ open }) => useMountTransition(open, 180), { initialProps: { open: true } });
    rerender({ open: false });
    rerender({ open: true });
    act(() => vi.advanceTimersByTime(180));
    expect(result.current).toBe(true); // reopen cancels the pending unmount
  });
});
