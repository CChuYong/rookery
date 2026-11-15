import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { SpeedControl } from "../src/renderer/components/SpeedControl.js";
import { useStore } from "../src/renderer/store/store.js";

// Audit #92: the speed control says what it chooses — the hint is always its tooltip, and forms get a labelled,
// bordered field instead of the composer's ghost chip.
beforeEach(() => useStore.getState().setCodexModels(null));

describe("SpeedControl meaning", () => {
  it("always carries the speed hint as its tooltip when nothing more specific applies", () => {
    render(<SpeedControl speed={null} model="claude-opus-4-8" onChange={vi.fn()} />);
    expect(screen.getByLabelText("속도")).toHaveAttribute("title", expect.stringContaining("Fast는 비용이 더 들 수 있습니다"));
  });

  it("field variant renders a bordered form select with a visible label", () => {
    render(<SpeedControl variant="field" speed={null} model="claude-opus-4-8" onChange={vi.fn()} />);
    const select = screen.getByLabelText("속도");
    expect(select.className).toContain("border-line");
    expect(screen.getByText("속도", { selector: "span" })).toBeVisible();
  });

  it("chip variant keeps the borderless composer look", () => {
    render(<SpeedControl speed={null} model="claude-opus-4-8" onChange={vi.fn()} />);
    expect(screen.getByLabelText("속도").className).toContain("border-0");
  });
});
