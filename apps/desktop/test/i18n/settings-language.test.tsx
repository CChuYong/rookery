import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { I18nProvider } from "../../src/renderer/i18n/provider.js";
import { SettingsPage } from "../../src/renderer/components/SettingsPage.js";
import { usePrefsStore } from "../../src/renderer/store/prefs.js";

const base = {
  settings: { masterModel: "claude-opus-4-8", masterEffort: "high", workerModel: "claude-opus-4-8", workerEffort: "high" } as never,
  onSave: () => {}, onClose: () => {}, slack: "off" as const, onSlackToggle: () => {},
};

describe("SettingsPage language section", () => {
  beforeEach(() => { usePrefsStore.setState({ localePref: "system" }); });
  it("changing the language select flips the whole page locale instantly", () => {
    render(<I18nProvider systemLocale="ko-KR"><SettingsPage {...base} /></I18nProvider>);
    expect(screen.getByText("워커 기본 모델 / effort")).toBeInTheDocument();
    act(() => { fireEvent.change(screen.getByDisplayValue("시스템 기본값"), { target: { value: "en" } }); });
    expect(screen.getByText("Default worker model / effort")).toBeInTheDocument();
    expect(screen.queryByText("워커 기본 모델 / effort")).toBeNull();
    expect(usePrefsStore.getState().localePref).toBe("en");
  });
});
