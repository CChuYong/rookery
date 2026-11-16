import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SettingsPage } from "../src/renderer/components/SettingsPage.js";

const base = {
  settings: { masterName: "rookery", masterModel: "m", workerModel: "w", masterEffort: "high", workerEffort: "high", slackCwd: "/work", slackAllowedUsers: "", slackAllowAll: "0", slackRefuseReply: "1", slackRefusalMessage: "Sorry, you're not authorized to use this bot.", slackLocale: "ko", usageRefreshMs: "120000", hasAcceptedDataNotice: "0", onboardingDone: "0", defaultSessionCwd: "", workerSlackRelayEnabled: "0", workerSlackRelayChannel: "", codexWorkerModel: "gpt-5.5", codexMasterModel: "gpt-5.5", codexBin: "codex", codexTurnIdleTimeoutMs: "0", codexHandshakeTimeoutMs: "30000", slackProvider: "claude", workerCostBudgetUsd: "", mcpExposure: "off" },
  onSave: () => {},
  onClose: () => {},
  slack: "off" as const,
  onSlackToggle: () => {},
};

describe("SettingsPage integrations", () => {
  it("shows GitHub status and saves a Linear key", () => {
    const onSaveLinearKey = vi.fn();
    render(<SettingsPage {...base} integrations={{ github: { available: true, user: "octo" }, linear: { configured: false } }} onSaveLinearKey={onSaveLinearKey} />);
    fireEvent.click(screen.getByText("연동")); // Switch to the Integrations tab (default is General)
    expect(screen.getByText(/octo/)).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/Linear API/i), { target: { value: "lin_xyz" } });
    fireEvent.click(screen.getByText("연결"));
    expect(onSaveLinearKey).toHaveBeenCalledWith("lin_xyz");
  });

  it("renders Slack language select and saves slackLocale", () => {
    const onSave = vi.fn();
    render(<SettingsPage {...base} onSave={onSave} />);
    fireEvent.click(screen.getByText("Slack")); // Switch to the Slack tab (default is General)
    const select = screen.getByLabelText(/Slack 언어|Slack language/);
    fireEvent.change(select, { target: { value: "en" } });
    fireEvent.click(screen.getByText("저장")); // Save button becomes enabled ("저장") once dirty
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ slackLocale: "en" }));
  });

  it("shows a neutral 'checking' state instead of 'auth needed' while integrations is still null (audit #15)", () => {
    render(<SettingsPage {...base} integrations={null} />);
    fireEvent.click(screen.getByText("연동")); // Switch to the Integrations tab
    expect(screen.getByText("확인 중…")).toBeInTheDocument(); // GitHub's standalone status badge
    expect(screen.getByText("Linear", { exact: false }).textContent).toContain("확인 중…");
    expect(screen.queryByText("gh auth login 필요")).toBeNull(); // no confident negative while unknown
  });

  it("keeps the 'auth needed' copy once integrations has actually loaded as unconfigured", () => {
    render(<SettingsPage {...base} integrations={{ github: { available: false }, linear: { configured: false } }} />);
    fireEvent.click(screen.getByText("연동"));
    expect(screen.getByText("gh auth login 필요")).toBeInTheDocument();
    expect(screen.queryByText("확인 중…")).toBeNull();
  });
});

describe("SettingsPage Slack token placeholders", () => {
  it("shows the xoxb-/xapp- hint placeholders when Slack is unconfigured", () => {
    render(<SettingsPage {...base} slack="unconfigured" />);
    fireEvent.click(screen.getByText("Slack"));
    expect(screen.getByPlaceholderText("xoxb-…")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("xapp-…")).toBeInTheDocument();
  });

  it("shows the 'saved' placeholder instead of the raw hint once Slack tokens are configured (audit #41)", () => {
    render(<SettingsPage {...base} slack="off" />);
    fireEvent.click(screen.getByText("Slack"));
    expect(screen.getAllByPlaceholderText("저장됨 — 교체하려면 새 값을 입력하세요").length).toBe(2); // bot + app token fields
    expect(screen.queryByPlaceholderText("xoxb-…")).toBeNull();
    expect(screen.queryByPlaceholderText("xapp-…")).toBeNull();
  });
});

// audit #47: a failed probe says so and offers a re-check instead of "checking…" forever.
describe("SettingsPage failed status probes", () => {
  it("integrations: 'couldn't check' with a Check again button that shows progress", async () => {
    let done!: () => void;
    const onRecheckStatus = vi.fn(() => new Promise<void>((res) => { done = res; }));
    render(<SettingsPage {...base} integrations={null} integrationsFailed onRecheckStatus={onRecheckStatus} />);
    fireEvent.click(screen.getByText("연동"));
    expect(screen.queryByText("확인 중…")).toBeNull();
    expect(screen.getAllByText(/확인하지 못했어요/).length).toBeGreaterThan(0);
    const btn = screen.getByRole("button", { name: "다시 확인" });
    fireEvent.click(btn);
    expect(onRecheckStatus).toHaveBeenCalledTimes(1);
    expect(btn).toHaveAttribute("aria-busy", "true");
    done();
  });

  it("Claude auth: 'couldn't check' replaces the endless checking label", () => {
    render(<SettingsPage {...base} authStatus={null} authStatusFailed onRecheckStatus={async () => {}} />);
    fireEvent.click(screen.getByText("모델"));
    expect(screen.getByText("확인하지 못했어요")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "다시 확인" })).toBeInTheDocument();
  });
});
