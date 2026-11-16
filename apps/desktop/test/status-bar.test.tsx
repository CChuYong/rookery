import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { UsageSnapshot } from "@daemon/core/usage.js";
import { StatusBar } from "../src/renderer/components/StatusBar.js";
import { useStore } from "../src/renderer/store/store.js";

const usage: UsageSnapshot = { session: null, weekly: null, today: { totalTokens: 1000, costUSD: 1.23 }, pct: null, codex: null, updatedAt: null, error: null };

const props = {
  daemon: "up" as const, daemonStatusText: "up", daemonJustUp: false,
  slack: "off" as const, slackStatusText: "꺼짐", slackJustUp: false,
  usage, usageLoadFailed: false, resources: null,
  onResourceRefresh: () => {}, onResourceOpenChange: () => {},
  notifyOn: true, onToggleNotify: () => {},
  capabilityActive: false, onToggleCapabilityCenter: () => {},
  automationActive: false, onToggleAutomation: () => {},
  settingsActive: false, onToggleSettings: () => {},
  restarting: false, onRestart: () => {},
  onAttentionNav: () => {}, routeKey: "s:1",
};

beforeEach(() => {
  useStore.setState({
    logsBySession: {}, liveInteractionIds: new Set(), fleet: {}, automations: [],
    attention: {}, sessionAttention: {}, sessions: [], activeSessionId: null, activeWorkerId: null, overlay: null,
  } as never);
});

describe("StatusBar", () => {
  // audit #20 + #19: one bell (the attention queue, which now also hosts the OS-notification toggle) in the always-
  // visible status bar instead of a bell in the sidebar header plus a second bell-shaped toggle here.
  it("shows exactly one bell — the attention queue — and no separate notification toggle", () => {
    render(<StatusBar {...props} />);
    expect(screen.getByLabelText(/알림 대기열/)).toBeInTheDocument();
    expect(screen.queryByLabelText("알림 켜짐 — 클릭해 끄기")).toBeNull();
    expect(screen.queryByLabelText("알림 꺼짐 — 클릭해 켜기")).toBeNull();
  });

  it("keeps restart, capabilities, automation and settings reachable", () => {
    const onRestart = vi.fn();
    render(<StatusBar {...props} onRestart={onRestart} />);
    fireEvent.click(screen.getByLabelText("데몬 재시작"));
    expect(onRestart).toHaveBeenCalledTimes(1);
    for (const name of ["Capability Center", "자동화", "설정"]) expect(screen.getByLabelText(name)).toBeInTheDocument();
  });

  // audit #25: the usage numbers were a dead span; the detail panel (titles, reset times, hints) couldn't be opened.
  it("opens the usage detail panel from the usage strip", () => {
    render(<StatusBar {...props} />);
    expect(screen.queryByText("Claude 사용량 (계정 전체)")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "사용량 자세히" }));
    expect(screen.getByText("Claude 사용량 (계정 전체)")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("Claude 사용량 (계정 전체)")).toBeNull();
  });

  // review m3: the popover is named, takes focus, and shares the provider tab with the strip.
  it("names the usage popover, moves focus into it, and keeps its provider tab in sync with the strip", () => {
    const withCodex = { ...usage, codex: { fiveHour: { usedPercent: 37, resetsAt: null }, sevenDay: null, planType: "pro", todayTokens: 1000, weeklyTokens: null } } as unknown as UsageSnapshot;
    render(<StatusBar {...props} usage={withCodex} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Codex" })[0]!); // the strip's switch
    fireEvent.click(screen.getByRole("button", { name: "사용량 자세히" }));
    const dialog = screen.getByRole("dialog", { name: "사용량 자세히" });
    expect(dialog).toHaveFocus();
    expect(dialog).toHaveTextContent("Codex 사용량");
  });

  it("closes the usage detail panel when the route changes", () => {
    const { rerender } = render(<StatusBar {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "사용량 자세히" }));
    rerender(<StatusBar {...props} routeKey="ov:settings:" />);
    expect(screen.queryByText("Claude 사용량 (계정 전체)")).toBeNull();
  });

  it("does not dress the Slack state as a button (no hover lift on a non-interactive item)", () => {
    render(<StatusBar {...props} />);
    expect(screen.getByText("Slack").parentElement!.className).not.toMatch(/hover:bg-raised/);
  });
});
