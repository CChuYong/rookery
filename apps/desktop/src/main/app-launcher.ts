// Backend for the "open the current cwd in another app" control. macOS only.
// Detects installed apps only (prefers an existing .app path, falling back to Spotlight `mdfind`) and
// opens the directory in that app via `open -a <app> <dir>` (no shell involved — execFile array args).
// Native dependencies (fs/electron app.getFileIcon/execFile) are all injected (LauncherDeps), so this is unit-testable.

export type AppKind = "editor" | "terminal" | "finder";

export interface CatalogEntry {
  id: string;
  name: string;
  kind: AppKind;
  paths: string[]; // candidate .app locations (first existing one wins)
  bundleId: string; // mdfind fallback + handles installs in non-standard locations
}

// Common modern IDEs/editors + the default Finder + major terminals. We filter by whether they're installed, so the candidate list is generous.
// Display order = this array's order (editors → Finder → terminals).
export const APP_CATALOG: CatalogEntry[] = [
  { id: "vscode", name: "VS Code", kind: "editor", bundleId: "com.microsoft.VSCode", paths: ["/Applications/Visual Studio Code.app"] },
  { id: "cursor", name: "Cursor", kind: "editor", bundleId: "com.todesktop.230313mzl4w4u92", paths: ["/Applications/Cursor.app"] },
  { id: "windsurf", name: "Windsurf", kind: "editor", bundleId: "com.exafunction.windsurf", paths: ["/Applications/Windsurf.app"] },
  { id: "zed", name: "Zed", kind: "editor", bundleId: "dev.zed.Zed", paths: ["/Applications/Zed.app"] },
  { id: "intellij", name: "IntelliJ IDEA", kind: "editor", bundleId: "com.jetbrains.intellij", paths: ["/Applications/IntelliJ IDEA.app", "/Applications/IntelliJ IDEA CE.app"] },
  { id: "webstorm", name: "WebStorm", kind: "editor", bundleId: "com.jetbrains.WebStorm", paths: ["/Applications/WebStorm.app"] },
  { id: "pycharm", name: "PyCharm", kind: "editor", bundleId: "com.jetbrains.pycharm", paths: ["/Applications/PyCharm.app", "/Applications/PyCharm CE.app"] },
  { id: "android-studio", name: "Android Studio", kind: "editor", bundleId: "com.google.android.studio", paths: ["/Applications/Android Studio.app"] },
  { id: "xcode", name: "Xcode", kind: "editor", bundleId: "com.apple.dt.Xcode", paths: ["/Applications/Xcode.app"] },
  { id: "sublime", name: "Sublime Text", kind: "editor", bundleId: "com.sublimetext.4", paths: ["/Applications/Sublime Text.app"] },
  { id: "finder", name: "Finder", kind: "finder", bundleId: "com.apple.finder", paths: ["/System/Library/CoreServices/Finder.app"] },
  { id: "terminal", name: "Terminal", kind: "terminal", bundleId: "com.apple.Terminal", paths: ["/System/Applications/Utilities/Terminal.app", "/Applications/Utilities/Terminal.app"] },
  { id: "iterm", name: "iTerm2", kind: "terminal", bundleId: "com.googlecode.iterm2", paths: ["/Applications/iTerm.app"] },
  { id: "warp", name: "Warp", kind: "terminal", bundleId: "dev.warp.Warp-Stable", paths: ["/Applications/Warp.app"] },
  { id: "ghostty", name: "Ghostty", kind: "terminal", bundleId: "com.mitchellh.ghostty", paths: ["/Applications/Ghostty.app"] },
];

export interface LauncherDeps {
  exists: (p: string) => boolean;
  mdfind?: (bundleId: string) => Promise<string | null>; // fallback for non-standard locations (Spotlight). If absent, only path checks are done.
  iconFor?: (appPath: string) => Promise<string | null>; // app icon dataURL (electron app.getFileIcon). If absent, null.
  open: (appPath: string, dir: string) => Promise<{ ok: boolean; error?: string }>;
}

export interface DetectedApp {
  id: string;
  name: string;
  kind: AppKind;
  icon: string | null; // dataURL or null
}

// Info.plist's CFBundleIconFile/CFBundleIconName value (extension may be omitted) → the actual .icns filename.
// (app.getFileIcon only returns a generic icon in this environment, so main converts the bundle's .icns directly via sips.)
export function icnsFileName(raw: string): string {
  const name = raw.trim();
  return name.toLowerCase().endsWith(".icns") ? name : `${name}.icns`;
}

// Resolves the actual path of an installed .app (prefers an existing path → mdfind fallback). null if not installed.
export async function resolveAppPath(
  entry: CatalogEntry,
  deps: Pick<LauncherDeps, "exists" | "mdfind">,
): Promise<string | null> {
  for (const p of entry.paths) if (deps.exists(p)) return p;
  if (deps.mdfind) {
    const found = await deps.mdfind(entry.bundleId);
    if (found) return found;
  }
  return null;
}

// Cross-platform fallback launcher (non-macOS, where the .app/open-a/mdfind/sips catalog above doesn't apply):
// a single "File manager" entry that reveals the directory via Electron shell.openPath (Explorer / file manager).
// openPath resolves to "" on success, or an error string. The editor/terminal catalog port is intentionally deferred.
export function createFileManagerLauncher(openPath: (dir: string) => Promise<string>): {
  list(): Promise<DetectedApp[]>;
  open(id: string, dir: string): Promise<{ ok: boolean; error?: string }>;
} {
  return {
    async list() {
      return [{ id: "files", name: "File manager", kind: "finder", icon: null }];
    },
    async open(_id, dir) {
      const err = await openPath(dir);
      return err ? { ok: false, error: err } : { ok: true };
    },
  };
}

export function createAppLauncher(deps: LauncherDeps, catalog: CatalogEntry[] = APP_CATALOG): {
  list(): Promise<DetectedApp[]>;
  open(id: string, dir: string): Promise<{ ok: boolean; error?: string }>;
} {
  return {
    async list() {
      const found = await Promise.all(
        catalog.map(async (e): Promise<DetectedApp | null> => {
          const path = await resolveAppPath(e, deps);
          if (!path) return null;
          const icon = deps.iconFor ? await deps.iconFor(path).catch(() => null) : null;
          return { id: e.id, name: e.name, kind: e.kind, icon };
        }),
      );
      return found.filter((x): x is DetectedApp => x !== null);
    },
    async open(id, dir) {
      const entry = catalog.find((e) => e.id === id);
      if (!entry) return { ok: false, error: `unknown app: ${id}` };
      const path = await resolveAppPath(entry, deps);
      if (!path) return { ok: false, error: `${entry.name} is not installed` };
      return deps.open(path, dir);
    },
  };
}
