// Feature flag for the dockable-panes workspace. Default ON — the dockview
// workspace is the default layout. Opt OUT of it (fall back to the legacy fixed
// layout) with localStorage.setItem("rookery.dockable","0"). Read at render time.
export function isDockableEnabled(): boolean {
  try {
    return localStorage.getItem("rookery.dockable") !== "0";
  } catch {
    return true;
  }
}
