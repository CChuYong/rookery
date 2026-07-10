import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SettingsPage } from "../src/renderer/components/SettingsPage.js";
import { useStore } from "../src/renderer/store/store.js";

// useT falls back to ko when no I18nProvider is mounted → the labels below are the ko strings.
const base = {
  settings: { masterName: "rookery", masterModel: "m", workerModel: "w", masterEffort: "high", workerEffort: "high", slackCwd: "/work", slackAllowedUsers: "", slackAllowAll: "0", slackRefuseReply: "1", slackRefusalMessage: "x", slackLocale: "ko", usageRefreshMs: "120000", hasAcceptedDataNotice: "0", onboardingDone: "0", defaultSessionCwd: "", workerSlackRelayEnabled: "0", workerSlackRelayChannel: "", codexWorkerModel: "gpt-5.5", codexMasterModel: "gpt-5.5", codexBin: "codex", codexTurnIdleTimeoutMs: "0", codexHandshakeTimeoutMs: "30000", slackProvider: "claude", workerCostBudgetUsd: "", mcpExposure: "off" },
  onSave: () => {},
  onClose: () => {},
  slack: "off" as const,
  onSlackToggle: () => {},
};

function openCodex() {
  fireEvent.click(screen.getByText("모델")); // Models umbrella tab
  fireEvent.click(screen.getByText("Codex")); // the pill sub-toggle
}

describe("SettingsPage — Codex auth-readiness card (auth probe)", () => {
  beforeEach(() => useStore.getState().setCodexAuthStatus(null));

  it("shows 'checking' while the probe is still in flight (status null) — not a confident 'not authenticated'", () => {
    render(<SettingsPage {...base} authStatus={null} />);
    openCodex();
    expect(screen.getByText("확인 중…")).toBeInTheDocument();
    expect(screen.queryByText("인증 없음")).toBeNull();
  });

  it("renders a chatgpt subscription account with the email/plan hint", () => {
    useStore.getState().setCodexAuthStatus({ method: "chatgpt", ready: true, hint: "u@x.io · plus" });
    render(<SettingsPage {...base} authStatus={null} />);
    openCodex();
    expect(screen.getByText("ChatGPT 구독")).toBeInTheDocument();
    expect(screen.getByText("u@x.io · plus")).toBeInTheDocument();
  });

  it("renders an api-key account as ready", () => {
    useStore.getState().setCodexAuthStatus({ method: "api-key", ready: true, hint: null });
    render(<SettingsPage {...base} authStatus={null} />);
    openCodex();
    expect(screen.getByText("API 키")).toBeInTheDocument();
    expect(screen.getByText(/Codex 마스터\/워커를 실행/)).toBeInTheDocument();
  });

  it("distinguishes a failed probe ('unavailable') from 'not authenticated' — points at the binary path, not codex login", () => {
    useStore.getState().setCodexAuthStatus("unavailable");
    render(<SettingsPage {...base} authStatus={null} />);
    openCodex();
    expect(screen.getByText("확인 불가")).toBeInTheDocument();
    expect(screen.getByText(/바이너리 경로가 맞는지/)).toBeInTheDocument();
    expect(screen.queryByText("인증 없음")).toBeNull(); // NOT the not-authenticated state
  });

  it("renders 'not authenticated' with the login guidance when the probe reports none", () => {
    useStore.getState().setCodexAuthStatus({ method: "none", ready: false, hint: null });
    render(<SettingsPage {...base} authStatus={null} />);
    openCodex();
    expect(screen.getByText("인증 없음")).toBeInTheDocument();
    expect(screen.getByText(/터미널에서 codex login을 실행/)).toBeInTheDocument(); // the auth-card desc (distinct from the API-key field hint)
  });
});
