import { app, BrowserWindow, ipcMain, dialog, Notification, screen, shell, session } from "electron";
import { buildCsp, isAllowedNavigation, decideWindowOpen } from "./csp.js";
import { loadWindowState, serializeWindowState } from "./window-state.js";
import { join, resolve, dirname } from "node:path";
import { homedir, cpus, totalmem, tmpdir } from "node:os";
import fs from "node:fs";
import http from "node:http";
import { spawn, execFile } from "node:child_process";
import { DaemonManager } from "./daemon-manager.js";
import { TerminalManager } from "./terminal-manager.js";
import type { PtyLike } from "./terminal-manager.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { resolveWorkRoot } from "./resolve-root.js";
import { createAppLauncher, icnsFileName } from "./app-launcher.js";
import { collectResources, parsePsRows } from "./resource-monitor.js";
import type { PsRow, ProcessMetricLike } from "./resource-monitor.js";
import { readFile as readFileP, writeFile as writeFileP, readdir as readdirP, stat as statP, mkdir as mkdirP, rename as renameP } from "node:fs/promises";
import { watch as fsWatch } from "node:fs";
import * as nodePty from "node-pty";
import electronUpdater from "electron-updater"; // default import: electron-updater is CJS; `import *` leaves autoUpdater (a lazy getter) undefined
import log from "electron-log/main";
import { setMainLocale } from "./i18n.js";
import { secureHomeAndLog, secureHomeDir } from "./fs-hardening.js";

// Node ABI required by the bundled better-sqlite3. Node 22 = 127. Update this when bumping the Node version (or override via env).
const REQUIRED_NODE_ABI = Number.parseInt(process.env.ROOKERY_NODE_ABI ?? "", 10) || 127;

// Query the ABI (process.versions.modules) of the external Node. null if it can't run (missing/error).
function probeNodeAbi(nodePath: string): Promise<number | null> {
  return new Promise((res) => {
    execFile(nodePath, ["-p", "process.versions.modules"], { timeout: 3000 }, (err, stdout) => {
      if (err) return res(null);
      const n = Number.parseInt(String(stdout).trim(), 10);
      res(Number.isFinite(n) ? n : null);
    });
  });
}

app.setName("Rookery"); // display name in the menu bar/Dock (including dev)

const HOST = process.env.ROOKERY_HOST ?? "127.0.0.1";
const PORT = Number.parseInt(process.env.ROOKERY_PORT ?? "8787", 10) || 8787;
// The daemon is spawned with an external Node (>=22) — because better-sqlite3's native ABI differs from Electron's bundled Node.
// dev: the dev script fills ROOKERY_NODE with the current Node path.
// packaged: uses the Node 22 (arm64) bundled via extraResources → the daemon comes up even if the user's machine
// has no Node or a mismatched ABI (fetch-node.mjs prepares it at build time). If the bundle is absent (e.g. an unsigned dir build), falls back to "node" on PATH.
const BUNDLED_NODE = app.isPackaged
  ? join(process.resourcesPath, "node", process.platform === "win32" ? "node.exe" : "node")
  : undefined;
const NODE_PATH =
  process.env.ROOKERY_NODE ?? (BUNDLED_NODE && fs.existsSync(BUNDLED_NODE) ? BUNDLED_NODE : "node");
const HOME = process.env.ROOKERY_HOME?.trim() || join(homedir(), ".rookery");
const WIN_STATE_FILE = join(HOME, "window-state.json");
// Relative to out/main: in dev, the repo root's dist (out/main → out → desktop → apps → root = ../../../../),
// when packaged, the daemon-dist in extraResources.
const DAEMON_ENTRY =
  process.env.ROOKERY_DAEMON_ENTRY ??
  (app.isPackaged
    ? join(process.resourcesPath, "daemon-dist/index.js")
    : resolve(__dirname, "../../../../dist/index.js"));

function ping(host: string, port: number): Promise<boolean> {
  return new Promise((res) => {
    const req = http.get({ host, port, path: "/health", timeout: 500 }, (r) => { r.resume(); res(r.statusCode === 200); });
    req.on("error", () => res(false));
    req.on("timeout", () => { req.destroy(); res(false); });
  });
}

const manager = new DaemonManager({
  host: HOST, port: PORT, nodePath: NODE_PATH, daemonEntry: DAEMON_ENTRY,
  requiredNodeAbi: REQUIRED_NODE_ABI,
  deps: {
    ping,
    probeNodeAbi,
    // Daemon stdout/stderr to a log file — makes startup failures (ABI mismatch/wrong path/missing keys) diagnosable.
    // If the repo has an .env, load it via --env-file (Slack tokens, etc.) → behaves the same as a manual `node --env-file=.env`.
    spawn: (node, entry) => {
      const fd = secureHomeAndLog(HOME);
      const envFile = process.env.ROOKERY_ENV_FILE ?? resolve(dirname(entry), "..", ".env");
      const args = [...(fs.existsSync(envFile) ? [`--env-file=${envFile}`] : []), entry, "daemon"];
      return spawn(node, args, { detached: true, stdio: ["ignore", fd, fd], env: process.env });
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    readPid: readDaemonPid,
    kill: (pid: number, sig: NodeJS.Signals) => process.kill(pid, sig),
  },
});

ipcMain.handle("daemon:ensure", () => manager.ensure());
ipcMain.handle("daemon:status", () => manager.status());
ipcMain.handle("daemon:restart", () => manager.restart());

// Custom window controls (frameless Windows/Linux builds). fromWebContents targets the sender's own window.
ipcMain.on("win:minimize", (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
ipcMain.on("win:maximize", (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return;
  if (w.isMaximized()) w.unmaximize();
  else w.maximize();
});
ipcMain.on("win:close", (e) => BrowserWindow.fromWebContents(e.sender)?.close());
ipcMain.handle("win:isMaximized", (e) => BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false);

// --- Auto-update: file logging (userData/logs/main.log) + lifecycle status pushed to the renderer + manual control. ---
log.initialize();
const au = electronUpdater.autoUpdater;
const pushUpdate = (status: string, extra: Record<string, unknown> = {}): void => {
  for (const w of BrowserWindow.getAllWindows()) { try { w.webContents.send("update:status", { status, ...extra }); } catch { /* window gone */ } }
};
// Guard so auto-update can never crash app startup (au should be defined with the default import — belt-and-suspenders).
if (au) {
  au.logger = log;
  // Install ONLY via the explicit "Restart to install" path (update:install), which stops the daemon first.
  // The daemon runs the bundled Node from inside the .app, so a quit-time auto-install would leave it running
  // → ShipIt aborts with "App Still Running" (SQRLInstallerErrorDomain -9).
  au.autoInstallOnAppQuit = false;
  au.on("checking-for-update", () => pushUpdate("checking"));
  au.on("update-available", (i) => pushUpdate("available", { version: i?.version }));
  au.on("update-not-available", () => pushUpdate("up-to-date"));
  au.on("error", (e) => pushUpdate("error", { message: String((e as Error)?.message ?? e) }));
  au.on("download-progress", (p) => pushUpdate("downloading", { percent: Math.round(p?.percent ?? 0) }));
  au.on("update-downloaded", (i) => pushUpdate("ready", { version: i?.version }));
}

ipcMain.handle("app:version", () => app.getVersion());
ipcMain.handle("update:check", async () => {
  if (!app.isPackaged || !au) { pushUpdate("dev"); return { ok: false, dev: true }; }
  try { const r = await au.checkForUpdates(); return { ok: true, version: r?.updateInfo?.version }; }
  catch (e) { const m = String((e as Error)?.message ?? e); pushUpdate("error", { message: m }); return { ok: false, error: m }; }
});
ipcMain.on("update:install", () => {
  void (async () => {
    // Stop the daemon first: it runs the bundled Node from inside the .app, so a live daemon makes Squirrel/ShipIt
    // abort the swap ("App Still Running", SQRLInstallerErrorDomain -9). The updated app respawns it on next launch.
    try { await manager.stop(); } catch (e) { log.warn("[updater] daemon stop before install", e); }
    try { au?.quitAndInstall(); } catch (e) { log.error("[updater] quitAndInstall", e); }
  })();
});

// Query the system locale + sync the renderer's chosen locale (i18n for main-side error messages).
setMainLocale(app.getLocale());
ipcMain.handle("system:getLocale", () => app.getLocale());
ipcMain.on("system:setLocale", (_e, locale: string) => setMainLocale(locale));
// Open external URLs in the default browser (ticket shortcuts, etc.). Allow only http(s) — prevents arbitrary scheme execution.
ipcMain.handle("shell:openExternal", (_e, url: string) => {
  if (typeof url === "string" && /^https?:\/\//i.test(url)) return shell.openExternal(url);
});
ipcMain.handle("daemon:wsUrl", () => {
  // Read the per-daemon token the daemon wrote to ~/.rookery/ws-token (0600) and use it for auth. Called after ensure(), so it exists.
  let token = "";
  try { token = fs.readFileSync(join(HOME, "ws-token"), "utf8").trim(); } catch { /* not there yet */ }
  return `ws://${HOST}:${PORT}/ws${token ? `?token=${encodeURIComponent(token)}` : ""}`;
});

// Read the daemon's single-instance pid file (~/.rookery/daemon.pid) and verify it's alive. null if absent or dead.
function readDaemonPid(): number | null {
  try {
    const pid = Number.parseInt(fs.readFileSync(join(HOME, "daemon.pid"), "utf8").trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    process.kill(pid, 0); // signal 0 = liveness check (throws if dead)
    return pid;
  } catch {
    return null;
  }
}

// Full process snapshot (pid/ppid/pcpu/rss). On failure, reject → collectResources drops the daemon to null.
function psSnapshot(): Promise<PsRow[]> {
  return new Promise((res, rej) => {
    execFile("ps", ["-axo", "pid=,ppid=,pcpu=,rss="], { timeout: 3000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return rej(err);
      res(parsePsRows(String(stdout)));
    });
  });
}

// Resource snapshot (app process + daemon tree). The renderer polls every few seconds.
ipcMain.handle("resources:get", () =>
  collectResources({
    getAppMetrics: () => app.getAppMetrics() as unknown as ProcessMetricLike[],
    readDaemonPid,
    psSnapshot,
    cpuCount: () => cpus().length,
    totalMem: () => totalmem(),
  }),
);

// Native folder picker (for entering a path when registering a repo). null if canceled.
ipcMain.handle("dialog:pickDirectory", async () => {
  const win = BrowserWindow.getFocusedWindow();
  const res = win
    ? await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] })
    : await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
  return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0];
});

// For attaching a file to the composer — returns the chosen absolute path as-is (the renderer inserts it as "@{path}"). null if canceled.
ipcMain.handle("dialog:pickFile", async () => {
  const win = BrowserWindow.getFocusedWindow();
  const res = win
    ? await dialog.showOpenDialog(win, { properties: ["openFile"] })
    : await dialog.showOpenDialog({ properties: ["openFile"] });
  return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0];
});

// OS notification for worker state transitions. Suppressed when a window is focused (i.e. already being watched) — this is for walk-away use.
// On click, surface the window and send a signal (notify:click) to the renderer to navigate to that worker.
ipcMain.handle("notify:show", (_e, p: { title: string; body: string; workerId: string }) => {
  const focused = BrowserWindow.getAllWindows().some((w) => w.isFocused());
  if (focused || !Notification.isSupported()) return;
  const n = new Notification({ title: p.title, body: p.body });
  n.on("click", () => {
    const w = BrowserWindow.getAllWindows()[0];
    if (!w) return;
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
    w.webContents.send("notify:click", p.workerId);
  });
  n.show();
});

// Read an Info.plist key — uses macOS `defaults`, which also reads binary plists (regex XML parsing won't work). null if absent.
function readPlistKey(appPath: string, key: string): Promise<string | null> {
  return new Promise((res) => {
    execFile("defaults", ["read", join(appPath, "Contents", "Info"), key], { timeout: 2000 }, (err, stdout) => {
      res(err ? null : (String(stdout).trim() || null));
    });
  });
}

// App bundle's .icns → 64px PNG dataURL. ⚠️ app.getFileIcon in this Electron environment returns the same
// blurry generic icon for every app (effectively invisible on a dark header) → convert the bundle's actual .icns directly with sips.
// If there's no .icns (e.g. apps that only use an asset catalog), null → the renderer shows a per-kind fallback icon.
async function appIconDataUrl(appPath: string): Promise<string | null> {
  const raw = (await readPlistKey(appPath, "CFBundleIconFile")) ?? (await readPlistKey(appPath, "CFBundleIconName"));
  if (!raw) return null;
  const icns = join(appPath, "Contents", "Resources", icnsFileName(raw));
  if (!fs.existsSync(icns)) return null;
  const out = join(tmpdir(), `rookery-icon-${Buffer.from(appPath).toString("base64url")}.png`);
  return new Promise((res) => {
    execFile("sips", ["-s", "format", "png", icns, "--out", out, "-z", "64", "64"], { timeout: 4000 }, (err) => {
      if (err) return res(null);
      try {
        const url = `data:image/png;base64,${fs.readFileSync(out).toString("base64")}`;
        try { fs.unlinkSync(out); } catch { /* ignore temp-file cleanup failure */ }
        res(url);
      } catch { res(null); }
    });
  });
}

// "Open the current cwd in another app" — detect installed IDEs/Finder/terminals, then open the directory via `open -a` (macOS).
const appLauncher = createAppLauncher({
  exists: fs.existsSync,
  // Spotlight fallback: if not at a standard path, find the actual install location by bundle ID (~/Applications, etc.).
  mdfind: (bundleId) => new Promise((res) => {
    execFile("mdfind", [`kMDItemCFBundleIdentifier == '${bundleId}'`], { timeout: 2500 }, (err, stdout) => {
      if (err) return res(null);
      const first = String(stdout).split("\n").map((s) => s.trim()).find((s) => s.endsWith(".app"));
      res(first ?? null);
    });
  }),
  iconFor: (appPath) => appIconDataUrl(appPath),
  open: (appPath, dir) => new Promise((res) => {
    execFile("open", ["-a", appPath, dir], (err) => res(err ? { ok: false, error: err.message } : { ok: true }));
  }),
});
ipcMain.handle("apps:list", () => appLauncher.list());
ipcMain.handle("apps:open", (_e, id: string, dir: string) => appLauncher.open(id, dir));

// Workspace filesystem bridge: the renderer accesses worker worktree files over ws:* IPC.
const workspace = new WorkspaceManager({
  fs: {
    readFile: readFileP,
    writeFile: (p, c) => writeFileP(p, c, "utf8"),
    readdir: (p) => readdirP(p, { withFileTypes: true }),
    stat: statP,
  },
  resolveRoot: (opts) => resolveWorkRoot({ rookeryHome: HOME, homeDir: homedir(), exists: fs.existsSync }, opts),
  homeDir: homedir(), // for ~ expansion in the chat @ autocomplete browse

  send: (channel, payload) => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload); },
  watch: (path, cb) => { const w = fsWatch(path, () => cb()); return { close: () => w.close() }; },
  // Recursive watch of the root — so the tree and git auto-refresh when an agent creates/deletes files.
  watchDir: (root, cb) => { const w = fsWatch(root, { recursive: true }, (_ev, file) => cb(file ? String(file) : null)); return { close: () => w.close() }; },
  exec: (cmd, args, cwd) => new Promise((res) => execFile(cmd, args, { cwd, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => res({ stdout: String(stdout), stderr: String(stderr), code: err ? 1 : 0 }))),
  mkdir: (p) => mkdirP(p, { recursive: true }).then(() => undefined),
  rename: (from, to) => renameP(from, to),
  trash: (p) => shell.trashItem(p),
});
ipcMain.handle("ws:resolveRoot", (_e, opts) => workspace.root(opts));
ipcMain.handle("ws:list", (_e, dir: string) => workspace.list(dir));
ipcMain.handle("ws:read", (_e, path: string) => workspace.read(path));
ipcMain.handle("ws:readImage", (_e, path: string) => workspace.readImage(path));
ipcMain.handle("ws:write", (_e, path: string, content: string) => workspace.write(path, content));
ipcMain.handle("ws:mkdir", (_e, path: string) => workspace.mkdir(path));
ipcMain.handle("ws:createFile", (_e, path: string) => workspace.createFile(path));
ipcMain.handle("ws:rename", (_e, from: string, to: string) => workspace.rename(from, to));
ipcMain.handle("ws:trash", (_e, path: string) => workspace.trash(path));
ipcMain.handle("ws:walk", (_e, root: string) => workspace.walk(root));
// Chat @ path autocomplete: read-only directory listing without the guard (allows browsing home/absolute paths).
ipcMain.handle("fs:browse", (_e, opts: { dir: string; subId?: string; cwd?: string }) => workspace.browse(opts));
// A fire-and-forget (.on) handler that throws would pop an uncaught-exception dialog, so wrap defensively (e.g. guard rejection).
ipcMain.on("ws:watch", (_e, path: string) => { try { workspace.watchFile(path); } catch { /* ignore */ } });
ipcMain.on("ws:unwatch", (_e, path: string) => { try { workspace.unwatchFile(path); } catch { /* */ } });
ipcMain.on("ws:watchTree", (_e, root: string) => { try { workspace.watchTree(root); } catch { /* */ } });
ipcMain.on("ws:unwatchTree", (_e, root: string) => { try { workspace.unwatchTree(root); } catch { /* */ } });
ipcMain.handle("git:status", (_e, cwd: string) => workspace.gitStatus(cwd));
ipcMain.handle("git:diff", (_e, cwd: string, path: string) => workspace.gitDiff(cwd, path));
ipcMain.handle("git:info", (_e, cwd: string) => workspace.gitInfo(cwd));
ipcMain.handle("git:changes", (_e, cwd: string) => workspace.gitChanges(cwd));
ipcMain.handle("git:stage", (_e, cwd: string, path: string) => workspace.gitStage(cwd, path));
ipcMain.handle("git:unstage", (_e, cwd: string, path: string) => workspace.gitUnstage(cwd, path));
ipcMain.handle("git:stageAll", (_e, cwd: string) => workspace.gitStageAll(cwd));
ipcMain.handle("git:discard", (_e, cwd: string, path: string, untracked: boolean) => workspace.gitDiscard(cwd, path, untracked));
ipcMain.handle("git:commit", (_e, cwd: string, message: string) => workspace.gitCommit(cwd, message));
ipcMain.handle("git:push", (_e, cwd: string) => workspace.gitPush(cwd));
ipcMain.handle("git:log", (_e, cwd: string, limit?: number) => workspace.gitLog(cwd, limit));
ipcMain.handle("git:commitInfo", (_e, cwd: string, hash: string) => workspace.gitCommitInfo(cwd, hash));
ipcMain.handle("git:commitFiles", (_e, cwd: string, hash: string) => workspace.gitCommitFiles(cwd, hash));
ipcMain.handle("git:showFileDiff", (_e, cwd: string, hash: string, path: string) => workspace.gitShowFileDiff(cwd, hash, path));

// Integrated terminal: the PTY is owned by main, streamed to the renderer's xterm over term:* IPC (not WS — an app-local OS feature).
const terminals = new TerminalManager({
  spawn: (shell, args, opts) => nodePty.spawn(shell, args, opts) as unknown as PtyLike,
  send: (channel, payload) => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload); },
  rookeryHome: HOME,
});
ipcMain.handle("term:create", (_e, opts) => terminals.create(opts));
ipcMain.handle("term:attach", (_e, id: string) => terminals.attach(id));
ipcMain.handle("term:list", (_e, sessionId: string) => terminals.list(sessionId));
// A fire-and-forget (.on) handler that throws would pop an uncaught-exception dialog, so wrap defensively (e.g. a dead PTY id).
ipcMain.on("term:write", (_e, id: string, data: string) => { try { terminals.write(id, data); } catch { /* ignore */ } });
ipcMain.on("term:resize", (_e, id: string, cols: number, rows: number) => { try { terminals.resize(id, cols, rows); } catch { /* */ } });
ipcMain.on("term:detach", (_e, id: string) => { try { terminals.detach(id); } catch { /* */ } });
ipcMain.on("term:kill", (_e, id: string) => { try { terminals.kill(id); } catch { /* */ } });
ipcMain.on("term:killSession", (_e, sessionId: string) => { try { terminals.killSession(sessionId); } catch { /* */ } });
app.on("before-quit", () => { terminals.killAll(); workspace.closeAll(); });

function createWindow(): void {
  const st = loadWindowState({
    read: () => { try { return fs.readFileSync(WIN_STATE_FILE, "utf8"); } catch { return null; } },
    displays: screen.getAllDisplays().map((d) => d.workArea),
  });
  const win = new BrowserWindow({
    width: st.width,
    height: st.height,
    ...(st.x !== undefined && st.y !== undefined ? { x: st.x, y: st.y } : {}),
    minWidth: 920,
    minHeight: 600,
    title: "Rookery",
    backgroundColor: "#0f1115",
    // macOS: hidden-inset title bar with native traffic lights. Windows/Linux: frameless → custom WindowControls in the renderer.
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const } : { frame: false }),
    autoHideMenuBar: true, // also drop the in-window File|Edit|View bar on Windows/Linux (no-op on macOS)
    webPreferences: { preload: resolve(__dirname, "../preload/index.cjs"), contextIsolation: true, nodeIntegration: false },
  });
  if (st.maximized) win.maximize();
  // Forward maximize state to the renderer so the custom WindowControls toggle their maximize/restore icon.
  const sendMax = (): void => { try { win.webContents.send("win:maximized", win.isMaximized()); } catch { /* */ } };
  win.on("maximize", sendMax);
  win.on("unmaximize", sendMax);
  // On window close, save the normal bounds + maximized state (restored on next launch).
  win.on("close", () => {
    try {
      secureHomeDir(HOME);
      fs.writeFileSync(WIN_STATE_FILE, serializeWindowState(win.getNormalBounds(), win.isMaximized()));
    } catch { /* best-effort */ }
  });
  // A shell rendering untrusted content — block new windows/external navigation (defense against XSS and LLM links).
  const devUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL;
  win.webContents.setWindowOpenHandler(({ url }) => {
    const d = decideWindowOpen(url);
    if (d.openExternal) void shell.openExternal(url); // isomorphic with the shell:openExternal scheme gate
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!isAllowedNavigation(url, devUrl)) e.preventDefault();
  });
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(resolve(__dirname, "../renderer/index.html"));
}

// Show the window first so the user sees the UI immediately. The renderer (App) drives daemon ensure over IPC,
// and shows a connected/offline banner based on the result (already-up/spawned/failed). (DaemonManager.ensure is the in-flight guard.)
void app.whenReady().then(() => {
  // Inject CSP once as a default-session response header (not per-window — avoids duplicate handlers when activate re-runs).
  const csp = buildCsp({ isDev: !app.isPackaged, host: HOST });
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [csp] } });
  });
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  // Auto-update (packaged only): check GitHub Releases, download in the background, install on quit.
  // No-op in dev. Reads the feed from app-update.yml baked from electron-builder's publish config.
  if (app.isPackaged && au) {
    void au.checkForUpdatesAndNotify().catch((e) => log.warn("[updater] launch check failed:", e));
  }
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
