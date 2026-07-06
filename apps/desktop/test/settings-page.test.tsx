import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SettingsPage } from "../src/renderer/components/SettingsPage.js";

const base = {
  settings: { masterName: "rookery", masterModel: "m", workerModel: "w", masterEffort: "high", workerEffort: "high", slackCwd: "/work", slackAllowedUsers: "", slackAllowAll: "0", slackRefuseReply: "1", slackRefusalMessage: "x", slackLocale: "ko", usageRefreshMs: "120000", hasAcceptedDataNotice: "0", onboardingDone: "0", defaultSessionCwd: "", workerSlackRelayEnabled: "0", workerSlackRelayChannel: "", codexWorkerModel: "gpt-5.5", codexBin: "codex" },
  onSave: () => {},
  onClose: () => {},
  slack: "off" as const,
  onSlackToggle: () => {},
};

describe("SettingsPage Anthropic API key input", () => {
  it("renders the API key input as a masked (password) field in the Claude tab", () => {
    render(<SettingsPage {...base} />);
    fireEvent.click(screen.getByText("Claude")); // switch to the Claude tab
    const input = screen.getByPlaceholderText(/sk-ant-/);
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute("type", "password");
  });

  it("calls onSaveAnthropicKey with the trimmed key when Save is clicked", () => {
    const onSaveAnthropicKey = vi.fn();
    render(<SettingsPage {...base} onSaveAnthropicKey={onSaveAnthropicKey} />);
    fireEvent.click(screen.getByText("Claude"));
    const input = screen.getByPlaceholderText(/sk-ant-/);
    fireEvent.change(input, { target: { value: "  sk-ant-abc123  " } });
    // There are multiple Save buttons; click the one in the Claude tab section
    const saveButtons = screen.getAllByText("저장"); // ko fallback
    const lastSave = saveButtons[saveButtons.length - 1]!;
    fireEvent.click(lastSave);
    expect(onSaveAnthropicKey).toHaveBeenCalledWith("sk-ant-abc123");
  });

  it("clears the input field after saving", () => {
    const onSaveAnthropicKey = vi.fn();
    render(<SettingsPage {...base} onSaveAnthropicKey={onSaveAnthropicKey} />);
    fireEvent.click(screen.getByText("Claude"));
    const input = screen.getByPlaceholderText(/sk-ant-/);
    fireEvent.change(input, { target: { value: "sk-ant-xyz" } });
    const saveButtons = screen.getAllByText("저장");
    fireEvent.click(saveButtons[saveButtons.length - 1]!);
    expect(input).toHaveValue("");
  });

  it("Save button is disabled when the input is blank", () => {
    render(<SettingsPage {...base} />);
    fireEvent.click(screen.getByText("Claude"));
    const saveButtons = screen.getAllByText("저장");
    const lastSave = saveButtons[saveButtons.length - 1]!;
    expect(lastSave).toBeDisabled();
  });

  it("does not call onSaveAnthropicKey when the prop is not provided (no crash)", () => {
    render(<SettingsPage {...base} />);
    fireEvent.click(screen.getByText("Claude"));
    const input = screen.getByPlaceholderText(/sk-ant-/);
    fireEvent.change(input, { target: { value: "sk-ant-test" } });
    const saveButtons = screen.getAllByText("저장");
    // Should not throw when prop is absent
    expect(() => fireEvent.click(saveButtons[saveButtons.length - 1]!)).not.toThrow();
  });
});

// ─── unsaved-changes guard on close (audit #18) ────────────────────────────
describe("SettingsPage unsaved-changes guard", () => {
  const closeBtn = (): HTMLElement => screen.getByLabelText("설정 닫기"); // ko fallback aria-label
  const makeDirty = (): void => {
    // botName field on the default (General) tab, pre-filled from base.settings.masterName
    fireEvent.change(screen.getByDisplayValue("rookery"), { target: { value: "changed" } });
  };

  it("not dirty + close closes immediately with no dialog", () => {
    const onClose = vi.fn();
    render(<SettingsPage {...base} onClose={onClose} />);
    fireEvent.click(closeBtn());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("dirty + close opens a confirm dialog and does NOT call onClose", () => {
    const onClose = vi.fn();
    render(<SettingsPage {...base} onClose={onClose} />);
    makeDirty();
    fireEvent.click(closeBtn());
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("저장 안 된 변경이 있어요")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Discard & close closes without saving", () => {
    const onClose = vi.fn();
    const onSave = vi.fn();
    render(<SettingsPage {...base} onClose={onClose} onSave={onSave} />);
    makeDirty();
    fireEvent.click(closeBtn());
    fireEvent.click(screen.getByText("버리고 닫기"));
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Save & close runs save then closes", () => {
    const order: string[] = [];
    const onSave = vi.fn(() => order.push("save"));
    const onClose = vi.fn(() => order.push("close"));
    render(<SettingsPage {...base} onClose={onClose} onSave={onSave} />);
    makeDirty();
    fireEvent.click(closeBtn());
    fireEvent.click(screen.getByText("저장하고 닫기"));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["save", "close"]);
  });

  it("Cancel stays on the page — dialog dismisses without closing", async () => {
    const onClose = vi.fn();
    render(<SettingsPage {...base} onClose={onClose} />);
    makeDirty();
    fireEvent.click(closeBtn());
    fireEvent.click(screen.getByText("취소"));
    expect(onClose).not.toHaveBeenCalled();
    // the dialog unmounts after its exit-transition timeout (useDismissTransition)
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
