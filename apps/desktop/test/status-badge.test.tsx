import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusBadge } from "../src/renderer/components/StatusBadge.js";

// Data bug: StatusBadge has its own TONE/DOT maps separate from lib/status.ts, but they lacked
// error/done keys, so the exact moment a worker finished (the state the user is waiting for) rendered as the gray fallback.
describe("StatusBadge terminal states (error/done)", () => {
  it("renders error with the fail tone, not the gray fallback", () => {
    const badge = render(<StatusBadge status="error" />).container.firstElementChild as HTMLElement;
    expect(badge.className).toContain("text-fail");
    expect(badge.className).not.toContain("text-muted"); // not the gray fallback
    const dot = badge.querySelector("span")!;
    expect(dot.className).toContain("bg-fail");
  });

  it("renders done with the green (pr) tone, not the gray fallback", () => {
    const badge = render(<StatusBadge status="done" />).container.firstElementChild as HTMLElement;
    expect(badge.className).toContain("text-pr");
    expect(badge.className).not.toContain("text-muted");
    const dot = badge.querySelector("span")!;
    expect(dot.className).toContain("bg-pr");
  });

  it("eases color changes via transition-colors", () => {
    const badge = render(<StatusBadge status="running" />).container.firstElementChild as HTMLElement;
    expect(badge.className).toContain("transition-colors");
  });
});

describe("StatusBadge status-flash (falling-edge)", () => {
  it("flashes the dot once on running→done", () => {
    const { rerender } = render(<StatusBadge status="running" />);
    rerender(<StatusBadge status="done" />);
    // "완료" is the localized (ko fallback, no provider) full word for "done" — see i18n/locales/ko/status.ts.
    const dot = screen.getByText("완료").querySelector("span")!;
    expect(dot.className).toContain("status-flash");
  });

  it("does NOT flash when mounted already-terminal (history replay)", () => {
    const dot = render(<StatusBadge status="done" />).container.querySelector("span > span")!;
    expect(dot.className).not.toContain("status-flash");
  });
});

// Audit #50: the header badge used to render the raw machine token (e.g. "orphaned") while the tree tag showed a
// cryptic abbreviation ("ORPH") — inconsistent AND untranslated. StatusBadge must now go through the shared
// statusLabelKey label source instead of echoing the raw status prop.
describe("StatusBadge localization (audit #50)", () => {
  it("renders the localized full word for orphaned, not the raw status token", () => {
    render(<StatusBadge status="orphaned" />);
    expect(screen.getByText("유실됨")).toBeInTheDocument();
    expect(screen.queryByText("orphaned")).not.toBeInTheDocument();
  });

  it("renders the localized full word for running, not the raw status token", () => {
    render(<StatusBadge status="running" />);
    expect(screen.getByText("실행 중")).toBeInTheDocument();
    expect(screen.queryByText("running")).not.toBeInTheDocument();
  });
});
