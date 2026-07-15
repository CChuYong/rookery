import fs from "node:fs";
import path from "node:path";
import type { CapabilityRegistry } from "../core/capabilities/registry.js";
import type { RepoChange, RepoRow, Repositories } from "../persistence/repositories.js";

type WatchCallback = (eventType: string, filename: string | Buffer | null) => void;
type WatchFunction = (filename: string, options: { persistent: boolean }, listener: WatchCallback) => fs.FSWatcher;

export interface CapabilityRepoWatcherOptions {
  debounceMs?: number;
  watch?: WatchFunction;
  warn?: (message: string) => void;
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 500 ? `${message.slice(0, 500)}…` : message;
}

function listDirectories(root: string): string[] {
  const directories: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    directories.push(current);
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) pending.push(path.join(current, entry.name));
    }
  }
  return directories;
}

export class CapabilityRepoWatcher {
  private readonly debounceMs: number;
  private readonly watch: WatchFunction;
  private readonly warn: (message: string) => void;
  private readonly watchers = new Map<string, fs.FSWatcher[]>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private unsubscribe?: () => void;
  private started = false;

  constructor(
    private readonly repos: Repositories,
    private readonly registry: CapabilityRegistry,
    options: CapabilityRepoWatcherOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? 200;
    this.watch = options.watch ?? ((filename, watchOptions, listener) => fs.watch(filename, watchOptions, listener));
    this.warn = options.warn ?? ((message) => process.stderr.write(`[rookery] ${message}\n`));
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    try { this.registry.reconcileRepoShared(); }
    catch (error) { this.warn(`capability repo discovery failed: ${safeMessage(error)}`); }
    for (const repo of this.repos.listRepos()) this.rebuild(repo);
    this.unsubscribe = this.repos.onRepoChanged((change) => this.onRepoChanged(change));
  }

  private onRepoChanged(change: RepoChange): void {
    if (change.kind === "removed") {
      this.cancel(change.repo.id);
      this.closeWatchers(change.repo.id);
      this.registry.invalidate(change.affected, change.repo.id);
      return;
    }
    this.rebuild(change.repo);
    this.schedule(change.repo);
  }

  private addWatcher(repo: RepoRow, directory: string, rootOnly: boolean): fs.FSWatcher | undefined {
    try {
      const watcher = this.watch(directory, { persistent: false }, (_event, filename) => {
        if (rootOnly && filename !== null) {
          const first = String(filename).split(/[\\/]/, 1)[0];
          if (first !== ".rookery") return;
        }
        this.schedule(repo);
      });
      watcher.on("error", (error) => this.warn(`capability watcher failed for repo ${repo.name}: ${safeMessage(error)}`));
      return watcher;
    } catch (error) {
      this.warn(`capability watcher unavailable for repo ${repo.name}: ${safeMessage(error)}`);
      return undefined;
    }
  }

  private rebuild(repo: RepoRow): void {
    this.closeWatchers(repo.id);
    const next: fs.FSWatcher[] = [];
    if (fs.existsSync(repo.path)) {
      const rootWatcher = this.addWatcher(repo, repo.path, true);
      if (rootWatcher) next.push(rootWatcher);
    }
    const rookery = path.join(repo.path, ".rookery");
    if (fs.existsSync(rookery)) {
      try {
        for (const directory of listDirectories(rookery)) {
          const watcher = this.addWatcher(repo, directory, false);
          if (watcher) next.push(watcher);
        }
      } catch (error) {
        this.warn(`capability watcher scan failed for repo ${repo.name}: ${safeMessage(error)}`);
      }
    }
    if (next.length > 0) this.watchers.set(repo.id, next);
  }

  private schedule(repo: RepoRow): void {
    if (!this.started) return;
    this.cancel(repo.id);
    const timer = setTimeout(() => {
      this.timers.delete(repo.id);
      try { this.registry.reconcileRepoShared(repo.id); }
      catch (error) { this.warn(`capability repo refresh failed for ${repo.name}: ${safeMessage(error)}`); }
      this.rebuild(repo);
    }, this.debounceMs);
    timer.unref?.();
    this.timers.set(repo.id, timer);
  }

  private cancel(repoId: string): void {
    const timer = this.timers.get(repoId);
    if (timer) clearTimeout(timer);
    this.timers.delete(repoId);
  }

  private closeWatchers(repoId: string): void {
    for (const watcher of this.watchers.get(repoId) ?? []) {
      try { watcher.close(); } catch { /* best-effort watcher cleanup */ }
    }
    this.watchers.delete(repoId);
  }

  close(): void {
    if (!this.started) return;
    this.started = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const repoId of [...this.timers.keys()]) this.cancel(repoId);
    for (const repoId of [...this.watchers.keys()]) this.closeWatchers(repoId);
  }
}
