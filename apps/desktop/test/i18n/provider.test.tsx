import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { I18nProvider, useT } from "../../src/renderer/i18n/provider.js";
import { usePrefsStore } from "../../src/renderer/store/prefs.js";

function Probe(): JSX.Element {
  const t = useT();
  return <span>{t("common.save")}</span>;
}

describe("I18nProvider / useT", () => {
  beforeEach(() => { usePrefsStore.setState({ localePref: "system" }); });
  it("renders ko when system is ko-KR", () => {
    render(<I18nProvider systemLocale="ko-KR"><Probe /></I18nProvider>);
    expect(screen.getByText("저장")).toBeInTheDocument();
  });
  it("renders en when system is en-US", () => {
    render(<I18nProvider systemLocale="en-US"><Probe /></I18nProvider>);
    expect(screen.getByText("Save")).toBeInTheDocument();
  });
  it("switches instantly when pref changes", () => {
    render(<I18nProvider systemLocale="en-US"><Probe /></I18nProvider>);
    act(() => usePrefsStore.getState().setLocalePref("ko"));
    expect(screen.getByText("저장")).toBeInTheDocument();
  });
  it("useT falls back to ko without a provider", () => {
    render(<Probe />);
    expect(screen.getByText("저장")).toBeInTheDocument();
  });
});
