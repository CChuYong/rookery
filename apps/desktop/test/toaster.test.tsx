import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { I18nProvider } from "../src/renderer/i18n/provider.js";
import { Toaster } from "../src/renderer/components/Toaster.js";
import { useToastStore, toast } from "../src/renderer/store/toasts.js";

// TTLs mirror Toaster.tsx (info/success 4500, error 7000) + the 140ms exit transition.
const INFO_TTL = 4500;
const EXIT = 140;

function renderToaster() {
  return render(
    <I18nProvider systemLocale="en">
      <Toaster />
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
  useToastStore.setState({ toasts: [] });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Toaster auto-expire", () => {
  it("expires a lone toast after its TTL", () => {
    renderToaster();
    act(() => { toast.info("solo"); });
    expect(screen.getByText("solo")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(INFO_TTL + EXIT));
    expect(screen.queryByText("solo")).toBeNull();
  });

  // The bug: ToastRow passed a fresh `() => dismiss(id)` each render, so the auto-expire effect's
  // dep changed every render and the TTL timer was cleared+reset. Pushing a second toast re-renders
  // the stack → the first toast's timer never fires while activity continues → "stays forever".
  it("does NOT reset a toast's timer when another toast is pushed mid-TTL", () => {
    renderToaster();
    act(() => { toast.info("A"); });
    act(() => vi.advanceTimersByTime(3000)); // partway through A's 4500ms TTL
    act(() => { toast.info("B"); }); // re-renders the stack — must NOT reset A's running timer
    act(() => vi.advanceTimersByTime(INFO_TTL - 3000 + EXIT)); // A reaches its original 4500ms → expires
    expect(screen.queryByText("A")).toBeNull(); // gone (bug: timer was reset → still showing)
    expect(screen.getByText("B")).toBeInTheDocument(); // B is still within its own TTL
  });
});
