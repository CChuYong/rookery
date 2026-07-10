import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { SettingsPage } from "../src/renderer/components/SettingsPage.js";
import { useStore } from "../src/renderer/store/store.js";
import type { CodexModelInfo } from "@daemon/protocol/messages.js";

const base = {
  settings: { masterName: "rookery", masterModel: "m", workerModel: "w", masterEffort: "high", workerEffort: "high", slackCwd: "/work", slackAllowedUsers: "", slackAllowAll: "0", slackRefuseReply: "1", slackRefusalMessage: "x", slackLocale: "ko", usageRefreshMs: "120000", hasAcceptedDataNotice: "0", onboardingDone: "0", defaultSessionCwd: "", workerSlackRelayEnabled: "0", workerSlackRelayChannel: "", codexWorkerModel: "gpt-5.5", codexMasterModel: "gpt-5.5", codexBin: "codex", codexTurnIdleTimeoutMs: "0", codexHandshakeTimeoutMs: "30000", slackProvider: "claude", workerCostBudgetUsd: "", mcpExposure: "off" },
  onSave: () => {},
  onClose: () => {},
  slack: "off" as const,
  onSlackToggle: () => {},
};

describe("SettingsPage Anthropic API key input", () => {
  it("renders the API key input as a masked (password) field in the Claude tab", () => {
    render(<SettingsPage {...base} />);
    fireEvent.click(screen.getByText("모델")); // switch to the Claude tab
    const input = screen.getByPlaceholderText(/sk-ant-/);
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute("type", "password");
  });

  it("calls onSaveAnthropicKey with the trimmed key when Save is clicked", () => {
    const onSaveAnthropicKey = vi.fn();
    render(<SettingsPage {...base} onSaveAnthropicKey={onSaveAnthropicKey} />);
    fireEvent.click(screen.getByText("모델"));
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
    fireEvent.click(screen.getByText("모델"));
    const input = screen.getByPlaceholderText(/sk-ant-/);
    fireEvent.change(input, { target: { value: "sk-ant-xyz" } });
    const saveButtons = screen.getAllByText("저장");
    fireEvent.click(saveButtons[saveButtons.length - 1]!);
    expect(input).toHaveValue("");
  });

  it("Save button is disabled when the input is blank", () => {
    render(<SettingsPage {...base} />);
    fireEvent.click(screen.getByText("모델"));
    const saveButtons = screen.getAllByText("저장");
    const lastSave = saveButtons[saveButtons.length - 1]!;
    expect(lastSave).toBeDisabled();
  });

  it("does not call onSaveAnthropicKey when the prop is not provided (no crash)", () => {
    render(<SettingsPage {...base} />);
    fireEvent.click(screen.getByText("모델"));
    const input = screen.getByPlaceholderText(/sk-ant-/);
    fireEvent.change(input, { target: { value: "sk-ant-test" } });
    const saveButtons = screen.getAllByText("저장");
    // Should not throw when prop is absent
    expect(() => fireEvent.click(saveButtons[saveButtons.length - 1]!)).not.toThrow();
  });
});

describe("SettingsPage Codex tab", () => {
  it("is reachable via the tab bar and shows the codexBin/codexWorkerModel/codexMasterModel fields", () => {
    render(<SettingsPage {...base} />);
    fireEvent.click(screen.getByText("모델")); fireEvent.click(screen.getByText("Codex"));
    expect(screen.getByDisplayValue("codex")).toBeInTheDocument();
    // codexWorkerModel and codexMasterModel share the same "gpt-5.5" fixture default → two inputs match.
    expect(screen.getAllByDisplayValue("gpt-5.5")).toHaveLength(2);
  });

  it("editing codexBin lands in the onSave(f) payload", () => {
    const onSave = vi.fn();
    render(<SettingsPage {...base} onSave={onSave} />);
    fireEvent.click(screen.getByText("모델")); fireEvent.click(screen.getByText("Codex"));
    fireEvent.change(screen.getByDisplayValue("codex"), { target: { value: "/usr/local/bin/codex" } });
    const saveButtons = screen.getAllByText("저장"); // ko fallback
    fireEvent.click(saveButtons[saveButtons.length - 1]!);
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ codexBin: "/usr/local/bin/codex" }));
  });

  it("editing codexMasterModel lands in the onSave(f) payload", () => {
    const onSave = vi.fn();
    render(<SettingsPage {...base} onSave={onSave} />);
    fireEvent.click(screen.getByText("모델")); fireEvent.click(screen.getByText("Codex"));
    // Disambiguate from the codexWorkerModel field (same default value) via its own label text. Regex because the
    // Field component's accessible name also folds in the trailing hint text, e.g. "...모델 새 Codex 마스터...".
    fireEvent.change(screen.getByLabelText(/Codex 마스터 기본 모델/), { target: { value: "gpt-6-mini" } });
    const saveButtons = screen.getAllByText("저장"); // ko fallback
    fireEvent.click(saveButtons[saveButtons.length - 1]!);
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ codexMasterModel: "gpt-6-mini" }));
  });

  it("renders the codexApiKey field as a masked (password) input", () => {
    render(<SettingsPage {...base} />);
    fireEvent.click(screen.getByText("모델")); fireEvent.click(screen.getByText("Codex"));
    const input = screen.getByPlaceholderText("sk-…");
    expect(input).toHaveAttribute("type", "password");
  });

  it("calls onSaveCodexKey with the typed key, clears the field, and shows a saved note (no auth-status probe)", () => {
    const onSaveCodexKey = vi.fn();
    render(<SettingsPage {...base} onSaveCodexKey={onSaveCodexKey} />);
    fireEvent.click(screen.getByText("모델")); fireEvent.click(screen.getByText("Codex"));
    const input = screen.getByPlaceholderText("sk-…");
    fireEvent.change(input, { target: { value: "sk-codex-abc" } });
    // Not dirty (no f-backed field touched) → the general Save button reads "저장됨", so "저장" uniquely
    // identifies this dedicated key-save button (mirrors the Anthropic-key block's single-match idiom).
    fireEvent.click(screen.getByText("저장"));
    expect(onSaveCodexKey).toHaveBeenCalledWith("sk-codex-abc");
    expect(input).toHaveValue("");
    // Same placeholder pattern the slack token fields use to indicate "already saved" (no separate auth-status check for codex).
    expect(screen.getByPlaceholderText("저장됨 — 교체하려면 새 값을 입력하세요")).toBeInTheDocument();
  });

  // ── Task 3 (Track C): codexTurnIdleTimeoutMs / codexHandshakeTimeoutMs fields ──

  it("shows the codexTurnIdleTimeoutMs and codexHandshakeTimeoutMs fields with values from settings", () => {
    render(<SettingsPage {...base} />);
    fireEvent.click(screen.getByText("모델")); fireEvent.click(screen.getByText("Codex"));
    expect(screen.getByDisplayValue("0")).toBeInTheDocument();
    expect(screen.getByDisplayValue("30000")).toBeInTheDocument();
  });

  it("editing codexTurnIdleTimeoutMs lands in the onSave(f) payload", () => {
    const onSave = vi.fn();
    render(<SettingsPage {...base} onSave={onSave} />);
    fireEvent.click(screen.getByText("모델")); fireEvent.click(screen.getByText("Codex"));
    // scope by label to avoid ambiguity with other Codex-tab fields
    fireEvent.change(screen.getByLabelText(/Codex 턴 유휴 타임아웃/), { target: { value: "60000" } });
    const saveButtons = screen.getAllByText("저장"); // ko fallback
    fireEvent.click(saveButtons[saveButtons.length - 1]!);
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ codexTurnIdleTimeoutMs: "60000" }));
  });

  it("editing codexHandshakeTimeoutMs lands in the onSave(f) payload", () => {
    const onSave = vi.fn();
    render(<SettingsPage {...base} onSave={onSave} />);
    fireEvent.click(screen.getByText("모델")); fireEvent.click(screen.getByText("Codex"));
    fireEvent.change(screen.getByLabelText(/Codex 핸드셰이크 타임아웃/), { target: { value: "5000" } });
    const saveButtons = screen.getAllByText("저장"); // ko fallback
    fireEvent.click(saveButtons[saveButtons.length - 1]!);
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ codexHandshakeTimeoutMs: "5000" }));
  });
});

// ── Codex Model Picker Task 4: codexWorkerModel/codexMasterModel selects driven by codex.models.list ──
const CODEX_MODELS: CodexModelInfo[] = [
  { id: "gpt-5.5", displayName: "GPT-5.5", defaultEffort: "xhigh", supportedEfforts: ["low", "medium", "high", "xhigh"], isDefault: true },
  { id: "gpt-5.4", displayName: "GPT-5.4", defaultEffort: "medium", supportedEfforts: ["low", "medium", "high"], isDefault: false },
];

describe("SettingsPage Codex tab — model defaults as selects (Codex Model Picker Task 4)", () => {
  beforeEach(() => {
    useStore.setState({ codexModels: null }); // reset the singleton store before each test
  });

  it("codexModels seeded → codexWorkerModel/codexMasterModel render as <Select>s listing the catalog + the '' default option", () => {
    useStore.getState().setCodexModels(CODEX_MODELS);
    render(<SettingsPage {...base} />);
    fireEvent.click(screen.getByText("모델")); fireEvent.click(screen.getByText("Codex"));

    const workerSelect = screen.getByLabelText(/Codex 워커 기본 모델/) as HTMLSelectElement;
    const masterSelect = screen.getByLabelText(/Codex 마스터 기본 모델/) as HTMLSelectElement;
    expect(workerSelect.tagName).toBe("SELECT");
    expect(masterSelect.tagName).toBe("SELECT");
    // both fixture defaults are "gpt-5.5" (a catalog id)
    expect(workerSelect.value).toBe("gpt-5.5");
    expect(masterSelect.value).toBe("gpt-5.5");
    expect(within(workerSelect).getByText("GPT-5.4")).toBeInTheDocument();
    expect(within(workerSelect).getByText("데몬 기본값 사용")).toBeInTheDocument(); // the "" default option
  });

  it("changing codexWorkerModel/codexMasterModel selects round-trips into the onSave(f) payload", () => {
    useStore.getState().setCodexModels(CODEX_MODELS);
    const onSave = vi.fn();
    render(<SettingsPage {...base} onSave={onSave} />);
    fireEvent.click(screen.getByText("모델")); fireEvent.click(screen.getByText("Codex"));

    fireEvent.change(screen.getByLabelText(/Codex 워커 기본 모델/), { target: { value: "gpt-5.4" } });
    fireEvent.change(screen.getByLabelText(/Codex 마스터 기본 모델/), { target: { value: "" } });
    const saveButtons = screen.getAllByText("저장"); // ko fallback
    fireEvent.click(saveButtons[saveButtons.length - 1]!);
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ codexWorkerModel: "gpt-5.4", codexMasterModel: "" }));
  });

  it("codexModels null → codexWorkerModel/codexMasterModel stay free-text <Input>s", () => {
    render(<SettingsPage {...base} />);
    fireEvent.click(screen.getByText("모델")); fireEvent.click(screen.getByText("Codex"));
    const workerField = screen.getByLabelText(/Codex 워커 기본 모델/);
    const masterField = screen.getByLabelText(/Codex 마스터 기본 모델/);
    expect(workerField.tagName).toBe("INPUT");
    expect(masterField.tagName).toBe("INPUT");
  });

  it("an out-of-list saved value (e.g. gpt-preview) is preserved as a selectable option", () => {
    useStore.getState().setCodexModels(CODEX_MODELS);
    render(<SettingsPage {...base} settings={{ ...base.settings, codexWorkerModel: "gpt-preview" }} />);
    fireEvent.click(screen.getByText("모델")); fireEvent.click(screen.getByText("Codex"));
    const workerSelect = screen.getByLabelText(/Codex 워커 기본 모델/) as HTMLSelectElement;
    expect(workerSelect.value).toBe("gpt-preview");
    expect(within(workerSelect).getByText("gpt-preview")).toBeInTheDocument();
  });
});

// ── Cost budget guard Task 3: workerCostBudgetUsd default field (General tab) ──
describe("SettingsPage workerCostBudgetUsd field", () => {
  it("renders the field in the General tab with the value from settings", () => {
    render(<SettingsPage {...base} settings={{ ...base.settings, workerCostBudgetUsd: "25" }} />);
    expect(screen.getByDisplayValue("25")).toBeInTheDocument();
  });

  it("empty by default shows the 'off' placeholder", () => {
    render(<SettingsPage {...base} />);
    expect(screen.getByPlaceholderText("off")).toBeInTheDocument();
  });

  it("editing the field lands in the onSave(f) bulk-save payload", () => {
    const onSave = vi.fn();
    render(<SettingsPage {...base} onSave={onSave} />);
    fireEvent.change(screen.getByPlaceholderText("off"), { target: { value: "10.5" } });
    const saveButtons = screen.getAllByText("저장"); // ko fallback
    fireEvent.click(saveButtons[saveButtons.length - 1]!);
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ workerCostBudgetUsd: "10.5" }));
  });
});

// ── External MCP server (rookery-as-MCP) section (General tab) ──
describe("SettingsPage External MCP section", () => {
  it("off (default): no URL, no regenerate button, no full-control warning", () => {
    render(<SettingsPage {...base} mcpStatus={{ scope: "off", url: null }} />);
    expect(screen.getByText("외부 MCP 서버")).toBeInTheDocument();
    expect(screen.queryByText("토큰 재발급")).not.toBeInTheDocument();
    expect(screen.queryByText(/전체 제어를 켜면/)).not.toBeInTheDocument();
  });

  it("changing the scope to full lands in onSave and shows the warning", () => {
    const onSave = vi.fn();
    render(<SettingsPage {...base} onSave={onSave} mcpStatus={{ scope: "off", url: null }} />);
    fireEvent.change(screen.getByLabelText(/노출 범위/), { target: { value: "full" } });
    expect(screen.getByText(/전체 제어를 켜면/)).toBeInTheDocument(); // warning appears immediately (f-backed)
    const saveButtons = screen.getAllByText("저장");
    fireEvent.click(saveButtons[saveButtons.length - 1]!);
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ mcpExposure: "full" }));
  });

  it("when active with a URL, shows the URL and a regenerate button that fires the callback", () => {
    const onRegenerateMcpToken = vi.fn();
    render(<SettingsPage {...base} settings={{ ...base.settings, mcpExposure: "readonly" }} mcpStatus={{ scope: "readonly", url: "http://127.0.0.1:8787/mcp-ext/tok" }} onRegenerateMcpToken={onRegenerateMcpToken} />);
    expect(screen.getByDisplayValue("http://127.0.0.1:8787/mcp-ext/tok")).toBeInTheDocument();
    fireEvent.click(screen.getByText("토큰 재발급"));
    expect(onRegenerateMcpToken).toHaveBeenCalled();
  });

  it("active but no URL yet (scope changed, not saved) prompts to save", () => {
    render(<SettingsPage {...base} settings={{ ...base.settings, mcpExposure: "full" }} mcpStatus={{ scope: "off", url: null }} />);
    expect(screen.getByText("저장하면 서버 URL이 생성돼요.")).toBeInTheDocument();
  });
});

// ── Task 3 (Track C): slackProvider select in the Slack tab ──
describe("SettingsPage Slack tab — slackProvider", () => {
  it("shows the slackProvider select defaulted to the settings value (claude)", () => {
    render(<SettingsPage {...base} />);
    fireEvent.click(screen.getByText("Slack"));
    const select = screen.getByLabelText(/Slack 에이전트 백엔드/) as HTMLSelectElement;
    expect(select.value).toBe("claude");
  });

  it("selecting codex lands in the onSave(f) payload", () => {
    const onSave = vi.fn();
    render(<SettingsPage {...base} onSave={onSave} />);
    fireEvent.click(screen.getByText("Slack"));
    fireEvent.change(screen.getByLabelText(/Slack 에이전트 백엔드/), { target: { value: "codex" } });
    const saveButtons = screen.getAllByText("저장"); // ko fallback
    fireEvent.click(saveButtons[saveButtons.length - 1]!);
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ slackProvider: "codex" }));
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
