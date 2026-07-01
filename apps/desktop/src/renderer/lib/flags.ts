// Feature flag for the dockable-panes workspace. OFF by default; opt in via
// localStorage.setItem("rookery.dockable","1") (dev). Read at render time.
export function isDockableEnabled(): boolean {
  try {
    return localStorage.getItem("rookery.dockable") === "1";
  } catch {
    return false;
  }
}
