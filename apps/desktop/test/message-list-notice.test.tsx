import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MessageList } from "../src/renderer/components/MessageList.js";
import { I18nProvider } from "../src/renderer/i18n/provider.js";
import type { LogItem } from "../src/renderer/store/reduce.js";

// MessageList takes `items: LogItem[]`; I18nProvider resolves the locale from the prefs
// store (default "system") + the injected systemLocale. systemLocale "en" → en catalog.
function renderEn(items: LogItem[]) {
  return render(
    <I18nProvider systemLocale="en">
      <MessageList items={items} />
    </I18nProvider>,
  );
}

describe("MessageList notice translation", () => {
  it("translates a coded notice to the active locale", () => {
    renderEn([
      {
        kind: "notice",
        text: "🗜 컨텍스트 압축됨 (auto, 84k→12k tok)",
        code: "notice.compact",
        params: { trigger: "auto", span: "84k→12k" },
      },
    ]);
    expect(screen.getByText(/Context compacted \(auto, 84k→12k tok\)/)).toBeTruthy();
    // the raw Korean pre-rendered text must NOT be shown when a code is present.
    expect(screen.queryByText(/컨텍스트 압축됨/)).toBeNull();
  });

  it("falls back to text when there is no code", () => {
    renderEn([{ kind: "notice", text: "Dropped deferred instruction (stopped): foo" }]);
    expect(screen.getByText(/Dropped deferred instruction/)).toBeTruthy();
  });
});
