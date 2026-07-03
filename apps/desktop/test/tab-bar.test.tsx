import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TabBar } from "../src/renderer/components/TabBar.js";
import { useWsStore } from "../src/renderer/store/workspace.js";

describe("TabBar close button keyboard focus reveal (audit #24)", () => {
  it("the close-X button reveals on focus-within/focus-visible, not just hover", () => {
    useWsStore.setState({
      byPage: { p1: { tabs: [{ id: "f1", kind: "file", path: "/x.ts", title: "x.ts", dirty: false }], activeTabId: "f1" } },
    });
    render(<TabBar pageKey="p1" agentLabel="Master" />);
    const closeBtn = screen.getByRole("button", { name: "탭 닫기" });
    // opacity-0 + group-hover:opacity-100 alone would stay invisible to a keyboard-only user — the
    // focus-within/focus-visible reveal (matching Sessions.tsx's row actions) must also be present.
    expect(closeBtn.className).toMatch(/\bopacity-0\b/);
    expect(closeBtn.className).toMatch(/\bgroup-focus-within:opacity-100\b/);
    expect(closeBtn.className).toMatch(/\bfocus-visible:opacity-100\b/);
  });
});
