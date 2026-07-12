import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { UsageSnapshot } from "@daemon/core/usage.js";
import { UsagePanel } from "../src/renderer/components/UsagePanel.js";

// useT() falls back to ko when no I18nProvider wraps the tree (see other component tests in this suite),
// so assertions below use the Korean catalog strings.

describe("UsagePanel", () => {
  it("collapses usage rows in compact-height mode and lets the user expand them", () => {
    const usage: UsageSnapshot = { session: null, weekly: null, today: { totalTokens: 1000, costUSD: 1.23 }, pct: null, codex: null, updatedAt: null, error: null };
    render(<UsagePanel usage={usage} compact />);
    expect(screen.queryByText("1.0k · $1.23")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "사용량 펼치기" }));
    expect(screen.getByText("1.0k · $1.23")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "사용량 접기" }));
    expect(screen.queryByText("1.0k · $1.23")).toBeNull();
  });

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
    const usage: UsageSnapshot = { session: null, weekly: null, today: { totalTokens: 1000, costUSD: 1.23 }, pct: null, codex: null, updatedAt: null, error: null };
    render(<UsagePanel usage={usage} />);
    expect(screen.getByText("Claude 사용량 (계정 전체)")).toBeInTheDocument();
    expect(screen.getByText("오늘")).toBeInTheDocument();
    expect(screen.getByText("1.0k · $1.23")).toBeInTheDocument();
  });

  const cx = { fiveHour: { usedPercent: 37, resetsAt: 1783762463 }, sevenDay: { usedPercent: 12, resetsAt: null }, planType: "pro", todayTokens: 1000, weeklyTokens: 1200 };
  const base: UsageSnapshot = { session: null, weekly: null, today: null, pct: null, codex: null, updatedAt: null, error: null };

  it("defaults to the Claude tab; clicking Codex swaps title and body", () => {
    render(<UsagePanel usage={{ ...base, today: { totalTokens: 1000, costUSD: 1.23 }, codex: cx }} />);
    expect(screen.getByText("Claude 사용량 (계정 전체)")).toBeInTheDocument(); // Claude default
    expect(screen.getByText("1.0k · $1.23")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    expect(screen.getByText("Codex 사용량 (계정 전체)")).toBeInTheDocument();
    expect(screen.getByText(/37%/)).toBeInTheDocument(); // 5h gauge
    expect(screen.getByText(/12%/)).toBeInTheDocument(); // weekly gauge
    expect(screen.getByText("1.0k")).toBeInTheDocument(); // today tokens, NO $
    expect(screen.queryByText("1.0k · $1.23")).toBeNull(); // claude body hidden
  });

  it("Codex tab without data shows the unavailable hint (tab stays discoverable)", () => {
    render(<UsagePanel usage={{ ...base, today: { totalTokens: 5, costUSD: 0 } }} />);
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    expect(screen.getByText("Codex 사용량 없음 — codex 설치/로그인을 확인하세요")).toBeInTheDocument();
  });

  it("switching back to Claude restores the claude body", () => {
    render(<UsagePanel usage={{ ...base, today: { totalTokens: 1000, costUSD: 1.23 }, codex: cx }} />);
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    fireEvent.click(screen.getByRole("button", { name: "Claude" }));
    expect(screen.getByText("1.0k · $1.23")).toBeInTheDocument();
  });

  it("Codex tab shows weekly tokens as a Stat when the weekly gauge is absent (partial data)", () => {
    render(<UsagePanel usage={{ ...base, codex: { ...cx, fiveHour: null, sevenDay: null, weeklyTokens: 1200000 } }} />);
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    expect(screen.getByText("주간")).toBeInTheDocument();
    expect(screen.getByText("1.2M")).toBeInTheDocument(); // weeklyTokens 1200000 → fmtTok
  });
});
