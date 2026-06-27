import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SettingsPage } from "../src/renderer/components/SettingsPage.js";

const base = {
  settings: { masterName: "rookery", masterModel: "m", workerModel: "w", masterEffort: "high", workerEffort: "high", slackCwd: "/work", slackAllowedUsers: "", slackAllowAll: "0", slackRefuseReply: "1", slackRefusalMessage: "x", slackLocale: "ko", usageRefreshMs: "120000", hasAcceptedDataNotice: "0" },
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
