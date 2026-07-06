import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { SettingsPage } from "../src/renderer/components/SettingsPage.js";
import { I18nProvider } from "../src/renderer/i18n/provider.js";

const base = {
  settings: { masterName: "rookery", masterModel: "m", workerModel: "w", masterEffort: "high", workerEffort: "high", slackCwd: "/work", slackAllowedUsers: "", slackAllowAll: "0", slackRefuseReply: "1", slackRefusalMessage: "x", slackLocale: "ko", usageRefreshMs: "120000", hasAcceptedDataNotice: "0", onboardingDone: "0", defaultSessionCwd: "", workerSlackRelayEnabled: "0", workerSlackRelayChannel: "", codexWorkerModel: "gpt-5.5", codexMasterModel: "gpt-5.5", codexBin: "codex", codexTurnIdleTimeoutMs: "120000", slackProvider: "claude" },
  onSave: () => {},
  onClose: () => {},
};

afterEach(() => { vi.useRealTimers(); });

describe("SettingsPage Slack toggle feedback (audit #53)", () => {
  it("disables the toggle and marks it busy between click and the slack.status prop change", () => {
    const onSlackToggle = vi.fn();
    const { rerender } = render(<SettingsPage {...base} slack="off" onSlackToggle={onSlackToggle} />);
    fireEvent.click(screen.getByText("Slack")); // switch to the Slack tab
    const toggle = screen.getByText("켜기").closest("button")!;
    expect(toggle).not.toBeDisabled();
    fireEvent.click(toggle);
    expect(onSlackToggle).toHaveBeenCalledWith(true);
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute("aria-busy", "true");
    // The daemon's slack.status event lands → the store's `slack` prop changes → busy clears.
    rerender(<SettingsPage {...base} slack="connecting" onSlackToggle={onSlackToggle} />);
    const toggleAfter = screen.getByText("끄기").closest("button")!;
    expect(toggleAfter).not.toBeDisabled();
    expect(toggleAfter).not.toHaveAttribute("aria-busy");
  });

  it("clears the busy state via a fallback timer even when no status event ever arrives (request itself rejected)", () => {
    vi.useFakeTimers();
    render(<SettingsPage {...base} slack="off" onSlackToggle={() => {}} />);
    fireEvent.click(screen.getByText("Slack"));
    const toggle = screen.getByText("켜기").closest("button")!;
    fireEvent.click(toggle);
    expect(toggle).toBeDisabled();
    act(() => { vi.advanceTimersByTime(6000); });
    expect(toggle).not.toBeDisabled();
  });
});

describe("SettingsPage Slack toggle wording (audit #81)", () => {
  it("labels the action 'Turn off'/'Turn on' distinct from the status word, in English", () => {
    const { rerender } = render(
      <I18nProvider systemLocale="en-US">
        <SettingsPage {...base} slack="up" onSlackToggle={() => {}} />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByText("Slack"));
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("Turn off")).toBeInTheDocument();
    expect(screen.queryByText("Off", { exact: true })).toBeNull();

    rerender(
      <I18nProvider systemLocale="en-US">
        <SettingsPage {...base} slack="off" onSlackToggle={() => {}} />
      </I18nProvider>,
    );
    expect(screen.getByText("Turn on")).toBeInTheDocument();
  });
});
