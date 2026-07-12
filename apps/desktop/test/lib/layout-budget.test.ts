import { describe, expect, it } from "vitest";
import {
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  isCompactSidebar,
  isShortViewport,
  shouldCompactDock,
  sidebarMaxForViewport,
} from "../../src/renderer/lib/layout-budget.js";

describe("desktop layout budget", () => {
  it("reserves the central workspace before honoring a wide saved sidebar", () => {
    expect(sidebarMaxForViewport(840)).toBe(SIDEBAR_MIN_WIDTH);
    expect(sidebarMaxForViewport(1000)).toBe(380);
    expect(sidebarMaxForViewport(1168)).toBe(SIDEBAR_MAX_WIDTH);
  });

  it("identifies compact sidebar and short-height modes at their boundaries", () => {
    expect(isCompactSidebar(239)).toBe(true);
    expect(isCompactSidebar(240)).toBe(false);
    expect(isShortViewport(679)).toBe(true);
    expect(isShortViewport(680)).toBe(false);
  });

  it("compacts dock side panels only below the usable-main threshold", () => {
    expect(shouldCompactDock(619)).toBe(true);
    expect(shouldCompactDock(719)).toBe(true);
    expect(shouldCompactDock(720)).toBe(false);
  });
});
