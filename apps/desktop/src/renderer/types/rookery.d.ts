// Type of window.rookery.ws. The declare global block in App.tsx splices this interface into rookery.
export interface RookeryWs {
  resolveRoot(opts: { subId?: string; cwd?: string }): Promise<string>;
  list(dir: string): Promise<Array<{ name: string; isDir: boolean }>>;
  read(path: string): Promise<{ content: string; tooLarge: boolean }>;
  readImage(path: string): Promise<{ dataUrl?: string; tooLarge?: boolean; unsupported?: boolean }>;
  write(path: string, content: string): Promise<{ ok: boolean }>;
  mkdir(p: string): Promise<{ ok: boolean }>;
  createFile(p: string): Promise<{ ok: boolean; exists?: boolean }>;
  rename(from: string, to: string): Promise<{ ok: boolean }>;
  trash(p: string): Promise<{ ok: boolean }>;
  walk(root: string): Promise<{ paths: string[]; truncated: boolean }>;
  watch(path: string): void;
  unwatch(path: string): void;
  watchTree(root: string): void;
  unwatchTree(root: string): void;
  onChanged(cb: (path: string) => void): () => void;
  onTree(cb: (root: string) => void): () => void;
  gitStatus(cwd: string): Promise<Array<{ path: string; status: string }>>;
  gitDiff(cwd: string, path: string): Promise<{ head: string; work: string }>;
  gitInfo(cwd: string): Promise<{ branch: string; ahead: number; behind: number; upstream: string | null }>;
  gitChanges(cwd: string): Promise<Array<{ path: string; x: string; y: string; added: number; deleted: number }>>;
  gitStage(cwd: string, path: string): Promise<{ ok: boolean; error?: string }>;
  gitUnstage(cwd: string, path: string): Promise<{ ok: boolean; error?: string }>;
  gitStageAll(cwd: string): Promise<{ ok: boolean; error?: string }>;
  gitDiscard(cwd: string, path: string, untracked: boolean): Promise<{ ok: boolean; error?: string }>;
  gitCommit(cwd: string, message: string): Promise<{ ok: boolean; error?: string }>;
  gitPush(cwd: string): Promise<{ ok: boolean; error?: string }>;
  gitLog(cwd: string, limit?: number): Promise<Array<{ hash: string; shortHash: string; subject: string; author: string; relDate: string }>>;
  gitCommitInfo(cwd: string, hash: string): Promise<{ hash: string; shortHash: string; author: string; email: string; date: string; subject: string; body: string }>;
  gitCommitFiles(cwd: string, hash: string): Promise<Array<{ path: string; status: string; added: number; deleted: number }>>;
  gitShowFileDiff(cwd: string, hash: string, path: string): Promise<{ before: string; after: string }>;
}

// Type of window.rookery.fs (chat @ path autocomplete). Unlike ws, it is not confined to the work root but read-only lists arbitrary directories.
export interface BrowseEntry {
  name: string;
  isDir: boolean;
  size?: number; // files only (omitted for folders)
}
export interface BrowseResult {
  dir: string; // resolved absolute path (the basis for chip path computation)
  entries: BrowseEntry[];
  error?: string; // readdir failure code (ENOENT, etc.) — a nonexistent path during partial typing
}
export interface RookeryFs {
  browse(opts: { dir: string; subId?: string; cwd?: string }): Promise<BrowseResult>;
}

// Type of window.rookery.term. The declare global block in App.tsx splices this interface into rookery.
// (rookery is an object-literal property, so merging it via a separate declare global would be a duplicate definition — hence it's extended directly in App.tsx.)
export interface RookeryTerm {
  create(opts: { sessionId: string; subId?: string; cwd?: string; cols?: number; rows?: number }): Promise<{ id?: string; error?: string }>;
  attach(id: string): Promise<{ scrollback: string }>;
  list(sessionId: string): Promise<Array<{ id: string; title: string; cwd: string; exited: boolean }>>;
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  detach(id: string): void;
  kill(id: string): void;
  killSession(sessionId: string): void;
  onData(cb: (id: string, data: string) => void): () => void;
  onExit(cb: (id: string, exitCode: number, signal?: number) => void): () => void;
}

// Type of window.rookery.resources. The declare global block in App.tsx splices it into rookery.
// (Same shape as main's resource-monitor.ts ResourceSnapshot — redeclared because the renderer doesn't import main.)
export interface ResourceBucket {
  cpuPct: number;
  memBytes: number;
}
export interface ResourceSnapshot {
  cpuPct: number;
  memBytes: number;
  ramSharePct: number;
  app: ResourceBucket & {
    main: ResourceBucket;
    renderer: ResourceBucket;
    other: ResourceBucket;
  };
  daemon: ResourceBucket | null;
}
export interface RookeryResources {
  get(): Promise<ResourceSnapshot>;
}

// Type of window.rookery.apps — "open the current cwd in another app" (installed-app detection + open -a).
export interface DetectedApp {
  id: string;
  name: string;
  kind: "editor" | "terminal" | "finder";
  icon: string | null; // app icon dataURL (null if absent → fallback icon)
}
export interface RookeryApps {
  list(): Promise<DetectedApp[]>;
  open(id: string, dir: string): Promise<{ ok: boolean; error?: string }>;
}

// Type of window.rookery.win — custom window controls for the frameless Windows/Linux builds.
export interface RookeryWin {
  minimize(): void;
  maximize(): void; // toggles maximize/restore
  close(): void;
  isMaximized(): Promise<boolean>;
  onMaximizeChange(cb: (maximized: boolean) => void): () => void;
}
