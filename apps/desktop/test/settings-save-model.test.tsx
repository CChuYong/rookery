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
    fireEvent.click(screen.getByRole("button", { name: "변경 버리기" }));
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
    expect(screen.queryByText("마스터 기본 모델 / 추론 강도")).toBeNull();
    fireEvent.click(screen.getByText("모델"));
    expect(screen.getByText("마스터 기본 모델 / 추론 강도")).toBeInTheDocument();
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

// Review fix 1: every way out of Settings asks before dropping unsaved edits — in-page links to the Capability
// Center and App-level navigation (sidebar, settings gear, back/forward) alike.
const emptyLibrary = { generation: 1, packs: [], bindings: [], diagnostics: [] };
function capApi(): import("../src/renderer/components/capabilities/types.js").CapabilityCenterApi {
  const unused = async (): Promise<never> => { throw new Error("unused"); };
  return {
    loadSnapshot: unused, loadLibrary: async () => emptyLibrary, createMcp: unused, createSkill: unused, createMcpPack: unused,
    addPack: unused, removePack: async () => {}, setTrust: unused, setSecret: unused, deleteSecret: unused,
    refresh: async () => emptyLibrary, reloadWorker: unused, setBinding: unused, quickSetBinding: async () => null, deleteBinding: async () => {},
  };
}

describe("SettingsPage leave guard", () => {
  it("an in-page Capability Center link with unsaved edits asks first; Cancel keeps the page and the edits", async () => {
    const onPreview = vi.fn();
    render(<SettingsPage {...base} capabilityApi={capApi()} onPreviewCapabilities={onPreview} />);
    fireEvent.change(screen.getByDisplayValue("rookery"), { target: { value: "changed" } });
    fireEvent.click(screen.getByRole("tab", { name: "Capabilities" }));
    fireEvent.click(await screen.findByRole("button", { name: "유효 상태 미리보기" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(onPreview).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("취소"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onPreview).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: "일반" }));
    expect(screen.getByDisplayValue("changed")).toBeInTheDocument();
  });

  it("Discard goes on to the link once; Save goes on only after the save", async () => {
    const onPreview = vi.fn();
    const onSave = vi.fn();
    render(<SettingsPage {...base} onSave={onSave} capabilityApi={capApi()} onPreviewCapabilities={onPreview} />);
    fireEvent.change(screen.getByDisplayValue("rookery"), { target: { value: "changed" } });
    fireEvent.click(screen.getByRole("tab", { name: "Capabilities" }));
    fireEvent.click(await screen.findByRole("button", { name: "유효 상태 미리보기" }));
    fireEvent.click(screen.getByText("버리고 닫기"));
    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "유효 상태 미리보기" }));
    fireEvent.click(screen.getByText("저장하고 닫기"));
    expect(onSave).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onPreview).toHaveBeenCalledTimes(2));
  });

  it("App navigation away (sidebar, gear) asks first; Cancel stays, Discard leaves", async () => {
    useStore.getState().restoreLocation({ overlay: "settings", showRepos: false, sessionId: null, subId: null, repoId: null });
    const close = () => useStore.getState().navigate({ overlay: null });
    render(<SettingsPage {...base} onClose={close} />);
    fireEvent.change(screen.getByDisplayValue("rookery"), { target: { value: "changed" } });

    // sidebar "Repos"
    act(() => useStore.getState().navigate({ overlay: null, showRepos: true }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(useStore.getState().overlay).toBe("settings");
    fireEvent.click(screen.getByText("취소"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(useStore.getState().overlay).toBe("settings");
    expect(screen.getByDisplayValue("changed")).toBeInTheDocument();

    // settings gear toggle
    act(() => useStore.getState().navigate({ overlay: null }));
    fireEvent.click(screen.getByText("버리고 닫기"));
    expect(useStore.getState().overlay).toBeNull();
  });

  it("a clean page leaves without asking", () => {
    useStore.getState().restoreLocation({ overlay: "settings", showRepos: false, sessionId: null, subId: null, repoId: null });
    render(<SettingsPage {...base} />);
    act(() => useStore.getState().navigate({ overlay: null, showRepos: true }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useStore.getState().overlay).toBeNull();
  });

  it("Save and close with an invalid budget keeps the page and shows why", async () => {
    const onClose = vi.fn();
    const onSave = vi.fn();
    render(<SettingsPage {...base} onSave={onSave} onClose={onClose} />);
    fireEvent.change(screen.getByPlaceholderText("제한 없음"), { target: { value: "-3" } });
    fireEvent.click(screen.getByRole("tab", { name: "Slack" }));
    fireEvent.click(screen.getByLabelText("설정 닫기"));
    fireEvent.click(screen.getByText("저장하고 닫기"));
    await act(async () => {});
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("tab", { name: "일반" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("0보다 큰 금액을 입력하거나 비워 두세요")).toBeInTheDocument();
  });

  it("Save and close while a save is running closes once that save succeeds", async () => {
    const d = deferred();
    const onClose = vi.fn();
    const onSave = vi.fn(() => d.promise);
    render(<SettingsPage {...base} onSave={onSave} onClose={onClose} />);
    fireEvent.change(screen.getByDisplayValue("rookery"), { target: { value: "changed" } });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    fireEvent.click(screen.getByLabelText("설정 닫기"));
    fireEvent.click(screen.getByText("저장하고 닫기"));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { d.resolve(); await d.promise; });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});
