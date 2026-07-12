export const SIDEBAR_MIN_WIDTH = 220;
export const SIDEBAR_MAX_WIDTH = 440;
export const MAIN_MIN_WIDTH = 620;
export const DOCK_COMPACT_WIDTH = 720;
export const SIDEBAR_COMPACT_WIDTH = 240;
export const SHORT_VIEWPORT_HEIGHT = 680;

export function sidebarMaxForViewport(viewportWidth: number): number {
  return Math.max(
    SIDEBAR_MIN_WIDTH,
    Math.min(SIDEBAR_MAX_WIDTH, viewportWidth - MAIN_MIN_WIDTH),
  );
}

export function isCompactSidebar(width: number): boolean {
  return width < SIDEBAR_COMPACT_WIDTH;
}

export function isShortViewport(height: number): boolean {
  return height < SHORT_VIEWPORT_HEIGHT;
}

export function shouldCompactDock(mainWidth: number): boolean {
  return mainWidth < DOCK_COMPACT_WIDTH;
}
