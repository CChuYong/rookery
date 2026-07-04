import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { UsageSnapshot } from "@daemon/core/usage.js";
import { UsagePanel } from "../src/renderer/components/UsagePanel.js";

// useT() falls back to ko when no I18nProvider wraps the tree (see other component tests in this suite),
// so assertions below use the Korean catalog strings.

describe("UsagePanel", () => {
  it("renders a skeleton (not nothing) while usage hasn't loaded yet — no pop-in later (audit #55)", () => {
    const { container } = render(<UsagePanel usage={null} />);
    // The title is present from the very first paint so the panel's height doesn't jump once data arrives (audit #56 too).
    expect(screen.getByText("Claude 사용량 (계정 전체)")).toBeInTheDocument();
    // A skeleton placeholder is rendered (Skeleton/SkeletonRows mark themselves aria-hidden).
    expect(container.querySelector("[aria-hidden]")).toBeTruthy();
    expect(screen.queryByText("사용량을 불러오지 못했어요")).toBeNull();
  });

  it("shows a load-failed hint instead of staying blank on sustained failure (audit #55)", () => {
    render(<UsagePanel usage={null} loadFailed />);
    expect(screen.getByText("사용량을 불러오지 못했어요")).toBeInTheDocument();
  });

  it("renders the account-wide title alongside loaded numbers (audit #56)", () => {
    const usage: UsageSnapshot = { session: null, weekly: null, today: { totalTokens: 1000, costUSD: 1.23 }, pct: null, updatedAt: null, error: null };
    render(<UsagePanel usage={usage} />);
    expect(screen.getByText("Claude 사용량 (계정 전체)")).toBeInTheDocument();
    expect(screen.getByText("오늘")).toBeInTheDocument();
    expect(screen.getByText("1.0k · $1.23")).toBeInTheDocument();
  });
});
