import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useJustEnded } from "../src/renderer/lib/useJustEnded.js";

describe("useJustEnded (falling-edge latch)", () => {
  it("is false on first render even when active is already false (no flash on replay-mount)", () => {
    const { result } = renderHook(({ active }) => useJustEnded(active), { initialProps: { active: false } });
    expect(result.current).toBe(false);
  });

  it("is false while active stays true", () => {
    const { result, rerender } = renderHook(({ active }) => useJustEnded(active), { initialProps: { active: true } });
    expect(result.current).toBe(false);
    rerender({ active: true });
    expect(result.current).toBe(false);
  });

  it("fires exactly once on the true→false transition", () => {
    const { result, rerender } = renderHook(({ active }) => useJustEnded(active), { initialProps: { active: true } });
    rerender({ active: false }); // the falling edge
    expect(result.current).toBe(true);
    rerender({ active: false }); // stays false — must not keep firing
    expect(result.current).toBe(false);
  });

  it("does not fire on the false→true (rising) edge", () => {
    const { result, rerender } = renderHook(({ active }) => useJustEnded(active), { initialProps: { active: false } });
    rerender({ active: true });
    expect(result.current).toBe(false);
  });

  it("can fire again on a second true→false transition", () => {
    const { result, rerender } = renderHook(({ active }) => useJustEnded(active), { initialProps: { active: true } });
    rerender({ active: false });
    expect(result.current).toBe(true);
    rerender({ active: true });
    expect(result.current).toBe(false);
    rerender({ active: false });
    expect(result.current).toBe(true);
  });
});
