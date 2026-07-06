import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { useStore } from "../src/renderer/store/store.js";
import { MODELS } from "../src/renderer/lib/models.js";
import { SettingsPage } from "../src/renderer/components/SettingsPage.js";

const settingsProps = {
  settings: { masterName: "rookery", masterModel: "claude-opus-4-7", workerModel: "claude-opus-4-7", masterEffort: "high", workerEffort: "high", slackCwd: "/work", slackAllowedUsers: "", slackAllowAll: "0", slackRefuseReply: "1", slackRefusalMessage: "Sorry, you're not authorized to use this bot.", slackLocale: "ko", usageRefreshMs: "120000", hasAcceptedDataNotice: "0", onboardingDone: "0", defaultSessionCwd: "", workerSlackRelayEnabled: "0", workerSlackRelayChannel: "", codexWorkerModel: "gpt-5.5", codexBin: "codex" },
  onSave: () => {},
  onClose: () => {},
  slack: "off" as const,
  onSlackToggle: () => {},
};

describe("live models (UI)", () => {
  beforeEach(() => {
    cleanup();
    useStore.setState({ models: [...MODELS] }); // reset to the static fallback before each test (singleton store)
  });

  it("store seeds models from the static fallback; setModels replaces, but an empty list keeps the fallback", () => {
    expect(useStore.getState().models.length).toBeGreaterThan(0); // default = static fallback (no flicker)
    useStore.getState().setModels([{ id: "live-x", label: "Live X" }]);
    expect(useStore.getState().models).toEqual([{ id: "live-x", label: "Live X" }]);
    useStore.getState().setModels([]); // empty response (no auth / offline) → keep the fallback
    expect(useStore.getState().models).toEqual([...MODELS]);
  });

  it("SettingsPage renders model <option>s from the live store list (not the hardcoded one)", () => {
    useStore.getState().setModels([{ id: "claude-opus-4-7", label: "Opus 4.7 (live)" }]);
    render(<SettingsPage {...settingsProps} />);
    // Worker select (General tab) renders the live label.
    expect(screen.getAllByText("Opus 4.7 (live)").length).toBeGreaterThanOrEqual(1);
    // Master default moved to the Slack tab — switch and verify it uses the live list too.
    fireEvent.click(screen.getByRole("tab", { name: "Slack" }));
    expect(screen.getAllByText("Opus 4.7 (live)").length).toBeGreaterThanOrEqual(1);
  });
});
