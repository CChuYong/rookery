import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { SettingsPage } from "../src/renderer/components/SettingsPage.js";
import { useStore } from "../src/renderer/store/store.js";

// useT falls back to ko when no I18nProvider is mounted, so the labels below are the ko strings.
const base = {
  settings: { masterName: "rookery", masterModel: "m", workerModel: "w", masterEffort: "high", workerEffort: "high", slackCwd: "/work", slackAllowedUsers: "", slackAllowAll: "0", slackRefuseReply: "1", slackRefusalMessage: "x", slackLocale: "ko", usageRefreshMs: "120000", hasAcceptedDataNotice: "0", onboardingDone: "0", defaultSessionCwd: "", workerSlackRelayEnabled: "0", workerSlackRelayChannel: "", codexWorkerModel: "gpt-5.5", codexMasterModel: "gpt-5.5", codexBin: "codex", codexTurnIdleTimeoutMs: "0", codexHandshakeTimeoutMs: "30000", slackProvider: "claude", workerCostBudgetUsd: "", mcpExposure: "off" },
  onSave: () => {},
  onClose: () => {},
  slack: "off" as const,
  onSlackToggle: () => {},
};

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// audit #93: one save model — a Save bar that stays reachable on every category and says how much is unsaved.
describe("SettingsPage save bar", () => {
  it("shows the unsaved count and keeps Save reachable after switching to a category without form fields", () => {
    const onSave = vi.fn();
    render(<SettingsPage {...base} onSave={onSave} />);
    fireEvent.change(screen.getByDisplayValue("rookery"), { target: { value: "changed" } });
    expect(screen.getByText("저장 안 된 변경 1개")).toBeInTheDocument();
    fireEvent.click(screen.getByText("연동"));
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ masterName: "changed" }));
  });

  it("marks the category that holds unsaved changes", () => {
    render(<SettingsPage {...base} />);
    expect(screen.getByRole("tab", { name: "일반" }).querySelector("[data-dirty-dot]")).toBeNull();
    fireEvent.change(screen.getByDisplayValue("rookery"), { target: { value: "changed" } });
    expect(screen.getByRole("tab", { name: "일반" }).querySelector("[data-dirty-dot]")).not.toBeNull();
    expect(screen.getByRole("tab", { name: "Slack" }).querySelector("[data-dirty-dot]")).toBeNull();
  });

  it("Revert drops the draft", () => {
    render(<SettingsPage {...base} />);
    fireEvent.change(screen.getByDisplayValue("rookery"), { target: { value: "changed" } });
    fireEvent.click(screen.getByRole("button", { name: "되돌리기" }));
    expect(screen.getByDisplayValue("rookery")).toBeInTheDocument();
    expect(screen.queryByText(/저장 안 된 변경/)).toBeNull();
  });

  it("shows progress while the save is in flight", async () => {
    const d = deferred();
    render(<SettingsPage {...base} onSave={() => d.promise} />);
    fireEvent.change(screen.getByDisplayValue("rookery"), { target: { value: "changed" } });
    const save = screen.getByRole("button", { name: "저장" });
    fireEvent.click(save);
    expect(save).toHaveAttribute("aria-busy", "true");
    await act(async () => { d.resolve(); await d.promise; });
    expect(save).not.toHaveAttribute("aria-busy");
  });

  it("Save & close stays on the page when the save fails", async () => {
    const onClose = vi.fn();
    const onSave = vi.fn(() => Promise.reject(new Error("nope")));
    render(<SettingsPage {...base} onSave={onSave} onClose={onClose} />);
    fireEvent.change(screen.getByDisplayValue("rookery"), { target: { value: "changed" } });
    fireEvent.click(screen.getByLabelText("설정 닫기"));
    fireEvent.click(screen.getByText("저장하고 닫기"));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue("changed")).toBeInTheDocument(); // the edit survives
  });
});

// audit #94: a secret input is cleared only after the daemon confirms the save.
describe("SettingsPage secret inputs", () => {
  it("keeps the Anthropic key in the field while saving, clears it after the save succeeds", async () => {
    const d = deferred();
    render(<SettingsPage {...base} onSaveAnthropicKey={() => d.promise} />);
    fireEvent.click(screen.getByText("모델"));
    const input = screen.getByPlaceholderText(/sk-ant-/);
    fireEvent.change(input, { target: { value: "sk-ant-abc" } });
    const btn = screen.getAllByText("저장").at(-1)!.closest("button")!;
    fireEvent.click(btn);
    expect(input).toHaveValue("sk-ant-abc");
    expect(screen.getByLabelText("Anthropic API 키 저장")).toHaveAttribute("aria-busy", "true");
    await act(async () => { d.resolve(); await d.promise; });
    expect(input).toHaveValue("");
  });

  it("keeps the Anthropic key when the save fails", async () => {
    render(<SettingsPage {...base} onSaveAnthropicKey={() => Promise.reject(new Error("bad"))} />);
    fireEvent.click(screen.getByText("모델"));
    const input = screen.getByPlaceholderText(/sk-ant-/);
    fireEvent.change(input, { target: { value: "sk-ant-abc" } });
    fireEvent.click(screen.getAllByText("저장").at(-1)!);
    await act(async () => {});
    expect(input).toHaveValue("sk-ant-abc");
  });

  it("shows the Codex 'saved' placeholder only after the save succeeds", async () => {
    render(<SettingsPage {...base} onSaveCodexKey={() => Promise.reject(new Error("bad"))} />);
    fireEvent.click(screen.getByText("모델")); fireEvent.click(screen.getByText("Codex"));
    const input = screen.getByPlaceholderText("sk-…");
    fireEvent.change(input, { target: { value: "sk-codex" } });
    fireEvent.click(screen.getByText("저장"));
    await act(async () => {});
    expect(input).toHaveValue("sk-codex");
    expect(screen.queryByPlaceholderText("저장됨 — 교체하려면 새 값을 입력하세요")).toBeNull();
  });

  it("keeps the Slack tokens and the Linear key when their saves fail", async () => {
    const fail = () => Promise.reject(new Error("bad"));
    render(<SettingsPage {...base} onSaveSlackTokens={fail} onSaveLinearKey={fail} integrations={{ github: { available: false }, linear: { configured: false } }} />);
    fireEvent.click(screen.getByText("Slack"));
    const [bot, app] = screen.getAllByPlaceholderText("저장됨 — 교체하려면 새 값을 입력하세요");
    fireEvent.change(bot!, { target: { value: "xoxb-1" } });
    fireEvent.change(app!, { target: { value: "xapp-1" } });
    fireEvent.click(screen.getByText("토큰 저장"));
    await act(async () => {});
    expect(bot).toHaveValue("xoxb-1");
    expect(app).toHaveValue("xapp-1");

    fireEvent.click(screen.getByText("연동"));
    const lin = screen.getByPlaceholderText(/Linear API/);
    fireEvent.change(lin, { target: { value: "lin_1" } });
    fireEvent.click(screen.getByText("연결"));
    await act(async () => {});
    expect(lin).toHaveValue("lin_1");
  });
});

// audit #51: the Claude master default sits with the other model defaults, not under Slack.
describe("SettingsPage model defaults live together", () => {
  it("Models › Claude holds the master model and effort; the Slack tab no longer does", () => {
    const onSave = vi.fn();
    render(<SettingsPage {...base} onSave={onSave} />);
    fireEvent.click(screen.getByText("Slack"));
    expect(screen.queryByText("마스터 기본 모델 / 강도")).toBeNull();
    fireEvent.click(screen.getByText("모델"));
    expect(screen.getByText("마스터 기본 모델 / 강도")).toBeInTheDocument();
    const live = useStore.getState().models[0]!.id;
    fireEvent.change(screen.getByLabelText(/^마스터 기본 모델/), { target: { value: live } });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ masterModel: live }));
  });
});

// audit #119: millisecond fields say what the number means.
describe("SettingsPage millisecond fields", () => {
  it("spells out the usage refresh interval", () => {
    render(<SettingsPage {...base} />);
    expect(screen.getByText("= 2분")).toBeInTheDocument();
  });
});
