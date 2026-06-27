import { contextBridge, ipcRenderer, webUtils } from "electron";
contextBridge.exposeInMainWorld("rookery", {
  daemon: {
    ensure: () => ipcRenderer.invoke("daemon:ensure") as Promise<string>,
    status: () => ipcRenderer.invoke("daemon:status") as Promise<string>,
    restart: () => ipcRenderer.invoke("daemon:restart") as Promise<string>,
  },
  wsUrl: () => ipcRenderer.invoke("daemon:wsUrl") as Promise<string>,
  pickDirectory: () => ipcRenderer.invoke("dialog:pickDirectory") as Promise<string | null>,
  pickFile: () => ipcRenderer.invoke("dialog:pickFile") as Promise<string | null>,
  // Open an external URL in the default browser (ticket shortcuts). main gates it with an http(s) whitelist.
  openExternal: (url: string) => ipcRenderer.invoke("shell:openExternal", url),
  // Dropped File → absolute path (Electron 32+ removed File.path → use webUtils). For drag-and-drop attachments in the chat box.
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  // Query the system locale + forward the renderer's chosen locale to main (syncs main-side error message i18n).
  system: {
    getLocale: () => ipcRenderer.invoke("system:getLocale") as Promise<string>,
    setLocale: (locale: string) => ipcRenderer.send("system:setLocale", locale),
  },
  // Chat @ path autocomplete: read-only directory listing without a guard (for browsing home/absolute paths). Separate from ws.list (which is confined to the work root).
  fs: {
    browse: (opts: { dir: string; subId?: string; cwd?: string }) =>
      ipcRenderer.invoke("fs:browse", opts) as Promise<{ dir: string; entries: Array<{ name: string; isDir: boolean; size?: number }>; error?: string }>,
  },
  notify: (p: { title: string; body: string; workerId: string }) => ipcRenderer.invoke("notify:show", p) as Promise<void>,
  onNotifyClick: (cb: (workerId: string) => void) => {
    const h = (_e: unknown, id: string): void => cb(id);
    ipcRenderer.on("notify:click", h);
    return () => { ipcRenderer.removeListener("notify:click", h); };
  },
  // Workspace filesystem bridge — access to worker worktree files (ws:*).
  ws: {
    resolveRoot: (opts: unknown) => ipcRenderer.invoke("ws:resolveRoot", opts) as Promise<string>,
    list: (dir: string) => ipcRenderer.invoke("ws:list", dir) as Promise<Array<{ name: string; isDir: boolean }>>,
    read: (path: string) => ipcRenderer.invoke("ws:read", path) as Promise<{ content: string; tooLarge: boolean }>,
    readImage: (path: string) => ipcRenderer.invoke("ws:readImage", path) as Promise<{ dataUrl?: string; tooLarge?: boolean; unsupported?: boolean }>,
    write: (path: string, content: string) => ipcRenderer.invoke("ws:write", path, content) as Promise<{ ok: boolean }>,
    mkdir: (p: string) => ipcRenderer.invoke("ws:mkdir", p) as Promise<{ ok: boolean }>,
    createFile: (p: string) => ipcRenderer.invoke("ws:createFile", p) as Promise<{ ok: boolean; exists?: boolean }>,
    rename: (from: string, to: string) => ipcRenderer.invoke("ws:rename", from, to) as Promise<{ ok: boolean }>,
    trash: (p: string) => ipcRenderer.invoke("ws:trash", p) as Promise<{ ok: boolean }>,
    walk: (root: string) => ipcRenderer.invoke("ws:walk", root) as Promise<{ paths: string[]; truncated: boolean }>,
    watch: (path: string) => ipcRenderer.send("ws:watch", path),
    unwatch: (path: string) => ipcRenderer.send("ws:unwatch", path),
    watchTree: (root: string) => ipcRenderer.send("ws:watchTree", root),
    unwatchTree: (root: string) => ipcRenderer.send("ws:unwatchTree", root),
    gitStatus: (cwd: string) => ipcRenderer.invoke("git:status", cwd) as Promise<Array<{ path: string; status: string }>>,
    gitDiff: (cwd: string, path: string) => ipcRenderer.invoke("git:diff", cwd, path) as Promise<{ head: string; work: string }>,
    gitInfo: (cwd: string) => ipcRenderer.invoke("git:info", cwd) as Promise<{ branch: string; ahead: number; behind: number; upstream: string | null }>,
    gitChanges: (cwd: string) => ipcRenderer.invoke("git:changes", cwd) as Promise<Array<{ path: string; x: string; y: string; added: number; deleted: number }>>,
    gitStage: (cwd: string, path: string) => ipcRenderer.invoke("git:stage", cwd, path) as Promise<{ ok: boolean; error?: string }>,
    gitUnstage: (cwd: string, path: string) => ipcRenderer.invoke("git:unstage", cwd, path) as Promise<{ ok: boolean; error?: string }>,
    gitStageAll: (cwd: string) => ipcRenderer.invoke("git:stageAll", cwd) as Promise<{ ok: boolean; error?: string }>,
    gitDiscard: (cwd: string, path: string, untracked: boolean) => ipcRenderer.invoke("git:discard", cwd, path, untracked) as Promise<{ ok: boolean; error?: string }>,
    gitCommit: (cwd: string, message: string) => ipcRenderer.invoke("git:commit", cwd, message) as Promise<{ ok: boolean; error?: string }>,
    gitPush: (cwd: string) => ipcRenderer.invoke("git:push", cwd) as Promise<{ ok: boolean; error?: string }>,
    gitLog: (cwd: string, limit?: number) => ipcRenderer.invoke("git:log", cwd, limit) as Promise<Array<{ hash: string; shortHash: string; subject: string; author: string; relDate: string }>>,
    gitCommitInfo: (cwd: string, hash: string) => ipcRenderer.invoke("git:commitInfo", cwd, hash) as Promise<{ hash: string; shortHash: string; author: string; email: string; date: string; subject: string; body: string }>,
    gitCommitFiles: (cwd: string, hash: string) => ipcRenderer.invoke("git:commitFiles", cwd, hash) as Promise<Array<{ path: string; status: string; added: number; deleted: number }>>,
    gitShowFileDiff: (cwd: string, hash: string, path: string) => ipcRenderer.invoke("git:showFileDiff", cwd, hash, path) as Promise<{ before: string; after: string }>,
    onChanged: (cb: (path: string) => void) => {
      const h = (_e: unknown, p: { path: string }): void => cb(p.path);
      ipcRenderer.on("fs:changed", h);
      return () => { ipcRenderer.removeListener("fs:changed", h); };
    },
    onTree: (cb: (root: string) => void) => {
      const h = (_e: unknown, p: { root: string }): void => cb(p.root);
      ipcRenderer.on("fs:tree", h);
      return () => { ipcRenderer.removeListener("fs:tree", h); };
    },
  },
  // Integrated terminal bridge — data flows over IPC (term:*), and the PTY is owned by main's TerminalManager.
  term: {
    create: (opts: unknown) => ipcRenderer.invoke("term:create", opts) as Promise<{ id?: string; error?: string }>,
    attach: (id: string) => ipcRenderer.invoke("term:attach", id) as Promise<{ scrollback: string }>,
    list: (sessionId: string) =>
      ipcRenderer.invoke("term:list", sessionId) as Promise<Array<{ id: string; title: string; cwd: string; exited: boolean }>>,
    write: (id: string, data: string) => ipcRenderer.send("term:write", id, data),
    resize: (id: string, cols: number, rows: number) => ipcRenderer.send("term:resize", id, cols, rows),
    detach: (id: string) => ipcRenderer.send("term:detach", id),
    kill: (id: string) => ipcRenderer.send("term:kill", id),
    killSession: (sessionId: string) => ipcRenderer.send("term:killSession", sessionId),
    onData: (cb: (id: string, data: string) => void) => {
      const h = (_e: unknown, p: { id: string; data: string }): void => cb(p.id, p.data);
      ipcRenderer.on("term:data", h);
      return () => { ipcRenderer.removeListener("term:data", h); };
    },
    onExit: (cb: (id: string, exitCode: number, signal?: number) => void) => {
      const h = (_e: unknown, p: { id: string; exitCode: number; signal?: number }): void => cb(p.id, p.exitCode, p.signal);
      ipcRenderer.on("term:exit", h);
      return () => { ipcRenderer.removeListener("term:exit", h); };
    },
  },
  // Resource monitor bridge — a snapshot collected by main via app.getAppMetrics + ps (resources:get).
  resources: {
    get: () => ipcRenderer.invoke("resources:get"),
  },
  // "Open the current cwd in another app" bridge — list of installed apps + open a directory (apps:*).
  apps: {
    list: () => ipcRenderer.invoke("apps:list") as Promise<Array<{ id: string; name: string; kind: string; icon: string | null }>>,
    open: (id: string, dir: string) => ipcRenderer.invoke("apps:open", id, dir) as Promise<{ ok: boolean; error?: string }>,
  },
});
