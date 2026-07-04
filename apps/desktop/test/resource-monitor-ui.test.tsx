import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ReactElement } from "react";
import { ResourceMonitor } from "../src/renderer/components/ResourceMonitor.js";
import { I18nProvider } from "../src/renderer/i18n/provider.js";
import { usePrefsStore } from "../src/renderer/store/prefs.js";
import { fmtBytes } from "../src/renderer/format.js";
import type { ResourceSnapshot } from "../src/renderer/types/rookery.js";

// Render through the English provider so the (now i18n'd) labels resolve to English assertions.
const renderEn = (ui: ReactElement) => render(<I18nProvider systemLocale="en-US">{ui}</I18nProvider>);

const snap: ResourceSnapshot = {
  cpuPct: 3,
  memBytes: 1.3 * 1024 ** 3,
  ramSharePct: 3,
  app: {
    cpuPct: 1,
    memBytes: 890 * 1024 ** 2,
    main: { cpuPct: 0.3, memBytes: 610 * 1024 ** 2 },
    renderer: { cpuPct: 0.7, memBytes: 280 * 1024 ** 2 },
    other: { cpuPct: 0, memBytes: 0 },
  },
  daemon: { cpuPct: 2, memBytes: 410 * 1024 ** 2 },
};

describe("fmtBytes", () => {
  it("formats MB with 1 decimal, GB with 2", () => {
    expect(fmtBytes(441 * 1024 ** 2)).toBe("441.0 MB");
    expect(fmtBytes(1.16 * 1024 ** 3)).toBe("1.16 GB");
  });
});

describe("ResourceMonitor", () => {
  beforeEach(() => { usePrefsStore.setState({ localePref: "system" }); });

  it("shows total memory on the trigger, opens detail on click", () => {
    const onOpenChange = vi.fn();
    renderEn(<ResourceMonitor snapshot={snap} onOpenChange={onOpenChange} />);
    const trigger = screen.getByRole("button", { name: /resources/i });
    expect(trigger.textContent).toContain(fmtBytes(snap.memBytes));
    expect(screen.queryByText("Desktop App")).toBeNull();
    fireEvent.click(trigger);
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(screen.getByText("Desktop App")).toBeInTheDocument();
    expect(screen.getByText("Daemon")).toBeInTheDocument();
    expect(screen.getByText("Main")).toBeInTheDocument();
    expect(screen.getByText("Renderer")).toBeInTheDocument();
  });

  it("shows placeholder when daemon is null", () => {
    renderEn(<ResourceMonitor snapshot={{ ...snap, daemon: null }} />);
    fireEvent.click(screen.getByRole("button", { name: /resources/i }));
    expect(screen.getByText("Daemon offline")).toBeInTheDocument();
  });

  it("renders a dash and no popover when snapshot is null", () => {
    renderEn(<ResourceMonitor snapshot={null} />);
    const trigger = screen.getByRole("button", { name: /resources/i });
    expect(trigger.textContent).toContain("—");
    fireEvent.click(trigger);
    expect(screen.queryByText("Desktop App")).toBeNull();
  });
});

// audit #61: the popover used to close only on outside click and never moved focus inside.
describe("ResourceMonitor keyboard/focus (audit #61)", () => {
  beforeEach(() => { usePrefsStore.setState({ localePref: "system" }); });

  it("moves focus to the Refresh button on open", () => {
    const onRefresh = vi.fn();
    renderEn(<ResourceMonitor snapshot={snap} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole("button", { name: /resources/i }));
    expect(screen.getByRole("button", { name: "Refresh" })).toHaveFocus();
  });

  it("falls back to focusing the panel when there is no Refresh handler", () => {
    renderEn(<ResourceMonitor snapshot={snap} />);
    fireEvent.click(screen.getByRole("button", { name: /resources/i }));
    expect(screen.getByText("Desktop App").closest("div.absolute")).toHaveFocus();
  });

  it("closes on Escape", () => {
    const onOpenChange = vi.fn();
    renderEn(<ResourceMonitor snapshot={snap} onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByRole("button", { name: /resources/i }));
    expect(screen.getByText("Desktop App")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("Desktop App")).toBeNull();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });
});
