export interface WindowState { width: number; height: number; x?: number; y?: number; maximized?: boolean }
export interface Display { x: number; y: number; width: number; height: number }

const DEFAULT: WindowState = { width: 1280, height: 860 };

// Whether the saved window position overlaps some display's work-area (prevents off-screen restore after a monitor is disconnected).
function onSomeDisplay(x: number, y: number, w: number, h: number, displays: Display[]): boolean {
  return displays.some((d) => x < d.x + d.width && x + w > d.x && y < d.y + d.height && y + h > d.y);
}

export function loadWindowState(deps: { read: () => string | null; displays: Display[] }): WindowState {
  let raw: string | null;
  try { raw = deps.read(); } catch { raw = null; }
  if (!raw) return { ...DEFAULT };
  let o: Record<string, unknown>;
  try { o = JSON.parse(raw) as Record<string, unknown>; } catch { return { ...DEFAULT }; }
  const width = typeof o.width === "number" ? o.width : DEFAULT.width;
  const height = typeof o.height === "number" ? o.height : DEFAULT.height;
  const st: WindowState = { width, height, maximized: Boolean(o.maximized) };
  if (typeof o.x === "number" && typeof o.y === "number" && onSomeDisplay(o.x, o.y, width, height, deps.displays)) {
    st.x = o.x;
    st.y = o.y;
  }
  return st;
}

export function serializeWindowState(bounds: { x: number; y: number; width: number; height: number }, maximized: boolean): string {
  return JSON.stringify({ ...bounds, maximized });
}
