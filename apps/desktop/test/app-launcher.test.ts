import { describe, it, expect, vi } from "vitest";
import { createAppLauncher, resolveAppPath, icnsFileName, APP_CATALOG, type CatalogEntry } from "../src/main/app-launcher.js";

const catalog: CatalogEntry[] = [
  { id: "finder", name: "Finder", kind: "finder", paths: ["/System/Library/CoreServices/Finder.app"], bundleId: "com.apple.finder" },
  { id: "vscode", name: "VS Code", kind: "editor", paths: ["/Applications/Visual Studio Code.app"], bundleId: "com.microsoft.VSCode" },
  { id: "cursor", name: "Cursor", kind: "editor", paths: ["/Applications/Cursor.app"], bundleId: "com.todesktop.230313mzl4w4u92" },
  { id: "iterm", name: "iTerm2", kind: "terminal", paths: ["/Applications/iTerm.app"], bundleId: "com.googlecode.iterm2" },
];

describe("resolveAppPath", () => {
  const deps = {
    exists: (p: string) => p === "/Applications/Visual Studio Code.app",
    mdfind: vi.fn(async (id: string) => (id === "com.googlecode.iterm2" ? "/Users/me/Applications/iTerm.app" : null)),
  };

  it("prefers an existing candidate path", async () => {
    expect(await resolveAppPath(catalog[1], deps)).toBe("/Applications/Visual Studio Code.app");
    expect(deps.mdfind).not.toHaveBeenCalled();
  });

  it("falls back to mdfind (non-standard install location) when no path exists", async () => {
    expect(await resolveAppPath(catalog[3], deps)).toBe("/Users/me/Applications/iTerm.app");
  });

  it("returns null when neither path nor mdfind finds it", async () => {
    expect(await resolveAppPath(catalog[2], deps)).toBeNull();
  });
});

describe("createAppLauncher.list", () => {
  it("returns only installed apps, with icons resolved", async () => {
    const launcher = createAppLauncher({
      exists: (p) => p === "/System/Library/CoreServices/Finder.app" || p === "/Applications/Visual Studio Code.app",
      mdfind: async () => null,
      iconFor: async (path) => `data:icon:${path}`,
      open: async () => ({ ok: true }),
    }, catalog);
    const apps = await launcher.list();
    expect(apps.map((a) => a.id)).toEqual(["finder", "vscode"]);
    expect(apps[0]).toMatchObject({ name: "Finder", kind: "finder", icon: "data:icon:/System/Library/CoreServices/Finder.app" });
  });

  it("tolerates a failing icon resolver (icon=null, app still listed)", async () => {
    const launcher = createAppLauncher({
      exists: (p) => p === "/Applications/Visual Studio Code.app",
      iconFor: async () => { throw new Error("boom"); },
      open: async () => ({ ok: true }),
    }, catalog);
    const apps = await launcher.list();
    expect(apps).toEqual([{ id: "vscode", name: "VS Code", kind: "editor", icon: null }]);
  });
});

describe("createAppLauncher.open", () => {
  it("resolves the app path and opens the dir there", async () => {
    const open = vi.fn(async () => ({ ok: true }));
    const launcher = createAppLauncher({ exists: (p) => p === "/Applications/Cursor.app", open }, catalog);
    const r = await launcher.open("cursor", "/code/proj");
    expect(r.ok).toBe(true);
    expect(open).toHaveBeenCalledWith("/Applications/Cursor.app", "/code/proj");
  });

  it("errors on unknown app id", async () => {
    const launcher = createAppLauncher({ exists: () => true, open: async () => ({ ok: true }) }, catalog);
    expect((await launcher.open("nope", "/x")).ok).toBe(false);
  });

  it("errors when the app is not installed", async () => {
    const open = vi.fn(async () => ({ ok: true }));
    const launcher = createAppLauncher({ exists: () => false, open }, catalog);
    expect((await launcher.open("cursor", "/x")).ok).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
});

describe("icnsFileName", () => {
  it("appends .icns when the plist value omits the extension (Finder, idea)", () => {
    expect(icnsFileName("Finder")).toBe("Finder.icns");
    expect(icnsFileName("iTerm2 App Icon for Release")).toBe("iTerm2 App Icon for Release.icns");
  });
  it("keeps an existing .icns extension (case-insensitive) and trims", () => {
    expect(icnsFileName("Cursor.icns")).toBe("Cursor.icns");
    expect(icnsFileName("  idea.icns  ")).toBe("idea.icns");
    expect(icnsFileName("App.ICNS")).toBe("App.ICNS");
  });
});

describe("APP_CATALOG", () => {
  it("always includes Finder and Terminal (present on every mac)", () => {
    const ids = APP_CATALOG.map((e) => e.id);
    expect(ids).toContain("finder");
    expect(ids).toContain("terminal");
  });
  it("every entry has a unique id, at least one path, and a bundleId", () => {
    const ids = new Set<string>();
    for (const e of APP_CATALOG) {
      expect(e.paths.length).toBeGreaterThan(0);
      expect(e.bundleId).toBeTruthy();
      expect(ids.has(e.id)).toBe(false);
      ids.add(e.id);
    }
  });
});
