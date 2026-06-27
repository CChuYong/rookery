import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDismissTransition } from "../src/renderer/lib/useDismissTransition.js";

function mockReducedMotion(reduce: boolean): void {
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: reduce && q.includes("reduce"),
    media: q,
    addEventListener() {},
    removeEventListener() {},
  }));
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("useDismissTransition (child-delayed close for exit animation)", () => {
  it("plays the exit then calls onClose after the delay", () => {
    vi.useFakeTimers();
    mockReducedMotion(false);
    const onClose = vi.fn();
    const { result } = renderHook(() => useDismissTransition(onClose, 140));
    expect(result.current.closing).toBe(false);

    act(() => result.current.dismiss());
    expect(result.current.closing).toBe(true);
    expect(onClose).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(140));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes immediately (no delay) under prefers-reduced-motion", () => {
    vi.useFakeTimers();
    mockReducedMotion(true);
    const onClose = vi.fn();
    const { result } = renderHook(() => useDismissTransition(onClose, 140));
    act(() => result.current.dismiss());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(result.current.closing).toBe(false);
  });

  it("is idempotent — a second dismiss does not schedule another close", () => {
    vi.useFakeTimers();
    mockReducedMotion(false);
    const onClose = vi.fn();
    const { result } = renderHook(() => useDismissTransition(onClose, 140));
    act(() => result.current.dismiss());
    act(() => result.current.dismiss());
    act(() => vi.advanceTimersByTime(140));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
