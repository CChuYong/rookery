import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SettingsPage } from "../src/renderer/components/SettingsPage.js";
import { useStore } from "../src/renderer/store/store.js";
import { changedSettingKeys, toSettingsDraft } from "../src/renderer/lib/settings-draft.js";

// useT falls back to ko when no I18nProvider is mounted, so labels below are the ko strings.
const settings = { masterName: "rookery", masterModel: "claude-opus-5-5", workerModel: "claude-opus-5-5", masterModelSource: "recommended" as const, workerModelSource: "recommended" as const, claudeRecommendedModel: "claude-opus-5-5", masterEffort: "high", workerEffort: "high", slackCwd: "/work", slackAllowedUsers: "", slackAllowAll: "0", slackRefuseReply: "1", slackRefusalMessage: "x", slackLocale: "ko", usageRefreshMs: "120000", hasAcceptedDataNotice: "0", onboardingDone: "0", defaultSessionCwd: "", workerSlackRelayEnabled: "0", workerSlackRelayChannel: "", codexWorkerModel: "gpt-5.5", codexMasterModel: "gpt-5.5", codexBin: "codex", codexTurnIdleTimeoutMs: "0", codexHandshakeTimeoutMs: "30000", slackProvider: "claude", workerCostBudgetUsd: "", mcpExposure: "off" };
const base = { settings, onSave: () => {}, onClose: () => {}, slack: "off" as const, onSlackToggle: () => {} };

const openModels = () => fireEvent.click(screen.getByText("모델"));
const masterSelect = () => screen.getByText("마스터 기본 모델").closest("div")!.parentElement!.querySelector("select")!;

beforeEach(() => {
  useStore.getState().setModels([{ id: "claude-opus-5-5", label: "Claude Opus 5.5" }, { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" }]);
});

describe("Claude default model follows the SDK recommendation", () => {
  it("a default that follows the recommendation is a draft of \"\", not the resolved id", () => {
    expect(toSettingsDraft(settings).masterModel).toBe("");
    expect(toSettingsDraft({ ...settings, masterModelSource: "setting" }).masterModel).toBe("claude-opus-5-5");
    expect(changedSettingKeys(toSettingsDraft(settings), toSettingsDraft(settings))).toEqual([]);
  });

  it("shows a Recommended option naming the model, selected while nothing is saved", () => {
    render(<SettingsPage {...base} authStatus={null} />);
    openModels();
    const sel = masterSelect();
    expect(sel.value).toBe("");
    expect(sel.querySelector("option[value='']")!.textContent).toBe("추천 모델 (Claude Opus 5.5)");
    expect(screen.queryByText("저장 안 된 변경 1개")).toBeNull(); // following the recommendation is not a change
  });

  it("picking a model saves it; picking Recommended again saves \"\" (follow the recommendation)", async () => {
    const onSave = vi.fn();
    const { rerender } = render(<SettingsPage {...base} onSave={onSave} authStatus={null} />);
    openModels();
    fireEvent.change(masterSelect(), { target: { value: "claude-sonnet-5-5" } });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ masterModel: "claude-sonnet-5-5" }));

    const saved = { ...settings, masterModel: "claude-sonnet-5-5", masterModelSource: "setting" as const };
    rerender(<SettingsPage {...base} settings={saved} onSave={onSave} authStatus={null} />);
    fireEvent.change(masterSelect(), { target: { value: "" } });
    fireEvent.click(await screen.findByRole("button", { name: "저장" })); // the first save settles first
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ masterModel: "" }));
  });

  it("before the recommendation is known the option says Default with the model in use", () => {
    render(<SettingsPage {...base} settings={{ ...settings, masterModel: "claude-opus-4-8", masterModelSource: "fallback", claudeRecommendedModel: "" }} authStatus={null} />);
    openModels();
    expect(masterSelect().querySelector("option[value='']")!.textContent).toBe("기본값 (claude-opus-4-8)");
  });
});
