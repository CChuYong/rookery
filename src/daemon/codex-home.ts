import fs from "node:fs";
import path from "node:path";
import type { CodexMcpConfig } from "../core/codex/codex-capabilities.js";
import type { CodexRuntimeLaunchOptions } from "./capability-runtime.js";

// Track A (docs/2026-07-06-p25-codex-hardening.md) — closes P2 review I3: the bridge URL used to ride
// the per-turn child's argv (`-c mcp_servers.rookery.url="..."`), which on multi-user Linux is readable
// by any local user via /proc/<pid>/cmdline. This module materializes a per-session, rookery-managed
// CODEX_HOME whose config.toml (mode 0600) carries the URL instead — the child never sees it on its
// command line. Live-spiked in `.superpowers/sdd/probe-authlink.mjs`.

const ROOKERY_BLOCK_HEADER = "[mcp_servers.rookery]";

export interface MaterializeCodexHomeOpts {
  // In-app codexApiKey configured (Settings). When true, codex-backend.ts's openClient() provisions
  // auth.json into this SAME per-session dir via account/login/start — this module must not touch
  // auth.json in that case. When false, auth comes from a symlink to the user's real CODEX_HOME.
  apiKeySet: boolean;
  // The user's real CODEX_HOME (process.env.CODEX_HOME || ~/.codex) — source for config.toml
  // passthrough (model_providers/base_url/etc) and for the auth.json symlink target.
  realCodexHome: string;
  // Workers use a prefixed directory in the same codex-homes parent so every target is isolated
  // without creating another git worktree. Omitted for backwards-compatible master behavior.
  kind?: "master" | "worker";
  // Public, secret-free config projection. Secret values live only in managed.env and are merged
  // into the provider child environment by the backend; this module deliberately never reads them.
  managed?: CodexRuntimeLaunchOptions;
}

// Per-session CODEX_HOME directory rookery materializes for a codex master turn. Called fresh on
// every ensureSession (i.e. every turn): idempotent, so re-materializing never accumulates duplicate
// config blocks and a user's live edit to their real config.toml propagates on the session's NEXT
// turn (documented risk — see the spec's Risks section).
export function materializeCodexHome(
  rookeryHome: string,
  sessionKey: string,
  bridgeUrl: string | undefined,
  opts: MaterializeCodexHomeOpts,
): string {
  const dir = codexHomeDirFor(rookeryHome, sessionKey, opts.kind ?? "master");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700); // repair mode if the dir pre-existed with a looser mode (mkdirSync's mode is only applied on creation)
  } catch {
    /* best-effort */
  }

  const configPath = path.join(dir, "config.toml");
  writeConfigAtomically(configPath, buildConfigToml(opts.realCodexHome, bridgeUrl, opts.managed));

  if (!opts.apiKeySet) {
    const authLinkPath = path.join(dir, "auth.json");
    try {
      fs.unlinkSync(authLinkPath); // remove a stale symlink first (avoids EEXIST on re-materialize)
    } catch {
      /* not present — fine */
    }
    const realAuth = path.join(opts.realCodexHome, "auth.json");
    if (fs.existsSync(realAuth)) {
      try {
        fs.symlinkSync(realAuth, authLinkPath);
      } catch {
        /* best-effort: if this fails, the turn fails with a clear codex auth error — acceptable */
      }
    }
    // else: no real auth.json to link — skip; the turn fails with a clear codex auth error (acceptable, per spec).
  } else {
    // apiKeySet: provisioning writes auth.json here. Clear a stale symlink from a prior no-key run
    // (else account/read sees the symlinked real auth and skips provisioning) — but never touch a
    // real (provisioned) auth.json file.
    try {
      const a = path.join(dir, "auth.json");
      if (fs.lstatSync(a).isSymbolicLink()) fs.unlinkSync(a);
    } catch {
      /* absent — fine */
    }
  }
  // codex-backend.ts's openClient() provisions auth.json into THIS dir via account/login/start once
  // account/read reports requiresOpenaiAuth.

  return dir;
}

// P3 Track A (docs/2026-07-06-p3-codex-fork-automation.md) — seeds a freshly-forked codex master
// session's per-session CODEX_HOME with the SOURCE session's ENTIRE `sessions/` tree (parent +
// forked rollouts). `thread/fork` writes the forked rollout into whatever CODEX_HOME the fork child
// ran in (the source's home — see server.ts's forkCodexMaster), and that forked rollout is a DELTA
// that references the parent rollout: copying only the forked file would let `thread/resume` find the
// thread but lose conversation context (verified in `.superpowers/sdd/probe-fork-home2.mjs`). Copying
// the whole tree preserves context. Best-effort: a missing source `sessions/` dir (e.g. the source
// home was GC'd) is a silent no-op — the fork still runs, just without prior context — and this must
// never throw (called after the ephemeral fork child has already succeeded).
export function seedCodexHomeFromSource(rookeryHome: string, sourceSessionId: string, newSessionId: string): void {
  seedCodexTargetHomeFromSource(rookeryHome, sourceSessionId, newSessionId, "master");
}

export function seedCodexWorkerHomeFromSource(rookeryHome: string, sourceWorkerId: string, newWorkerId: string): void {
  seedCodexTargetHomeFromSource(rookeryHome, sourceWorkerId, newWorkerId, "worker");
}

function seedCodexTargetHomeFromSource(
  rookeryHome: string,
  sourceId: string,
  newId: string,
  kind: "master" | "worker",
): void {
  const src = path.join(codexHomeDirFor(rookeryHome, sourceId, kind), "sessions");
  if (!fs.existsSync(src)) return;
  const dst = path.join(codexHomeDirFor(rookeryHome, newId, kind), "sessions");
  // Best-effort, never throws (finding [21]): mkdirSync/cpSync can fail (ENOSPC, EACCES on a rollout
  // file, or the source home ripped out mid-copy by a concurrent session.delete). This runs AFTER the
  // ephemeral fork child already succeeded, so a copy failure must degrade to "fork without prior
  // context" — matching this function's documented contract above — not fail the whole fork.
  try {
    fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
    fs.cpSync(src, dst, { recursive: true });
  } catch {
    // best-effort — the fork still runs, just without the source's conversation context. Remove any
    // PARTIAL copy (a mid-copy ENOSPC / source-removed-mid-copy can leave a truncated rollout tree),
    // so the forked session degrades to "no prior context" cleanly instead of resuming a corrupt
    // rollout on every subsequent turn. The cleanup is itself guarded so this function still never throws.
    try { fs.rmSync(dst, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// Best-effort cleanup on session delete (item 6) — never throws. Removes the whole per-session
// CODEX_HOME (config.toml + auth.json + any codex-written rollout/session state under it).
export function removeCodexHome(rookeryHome: string, sessionKey: string): void {
  try {
    fs.rmSync(codexHomeDirFor(rookeryHome, sessionKey, "master"), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

export function removeCodexWorkerHome(rookeryHome: string, workerId: string): void {
  try {
    fs.rmSync(codexHomeDirFor(rookeryHome, workerId, "worker"), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

export function codexHomeDirFor(
  rookeryHome: string,
  targetId: string,
  kind: "master" | "worker" = "master",
): string {
  return path.join(rookeryHome, "codex-homes", kind === "worker" ? `worker-${targetId}` : targetId);
}

// P3-remaining Track B #7 — boot sweep for orphaned per-session CODEX_HOME dirs (docs/2026-07-06-p3r-
// codex-hardening-finish.md). A session delete that crashes between the DB cascade and the best-effort
// removeCodexHome call, or a fork whose createSession throws after seedCodexHomeFromSource, can leave a
// stray `<rookeryHome>/codex-homes/<id>/` dir with no backing session row. Called once at daemon boot
// (server.ts, after fleet.rehydrate()/resetRunningSessions()/resetRunningAutomations()) with the live
// session ids read fresh from the DB. ⚠️ Boot-only: no in-flight fork/create can race it at startup (the
// daemon hasn't accepted any connections yet), so this must NOT be called during normal operation.
// Best-effort, never throws — a missing codex-homes dir or a readdir failure (e.g. permission error, or
// the path existing as a non-directory) is a silent no-op.
export function gcOrphanCodexHomes(
  rookeryHome: string,
  liveSessionIds: Set<string>,
  liveWorkerIds: Set<string> = new Set(),
): void {
  const base = path.join(rookeryHome, "codex-homes");
  if (!fs.existsSync(base)) return;
  let names: string[];
  try {
    names = fs.readdirSync(base);
  } catch {
    return; // best-effort
  }
  for (const name of names) {
    if (name.startsWith("worker-")) {
      const workerId = name.slice("worker-".length);
      if (!liveWorkerIds.has(workerId)) removeCodexWorkerHome(rookeryHome, workerId);
    } else if (!liveSessionIds.has(name)) {
      removeCodexHome(rookeryHome, name); // removeCodexHome itself never throws
    }
  }
}

// Starts from the user's real config.toml (if present) — preserving model_providers/base_url/etc, so a
// minimal rookery-only config doesn't silently drop the user's customizations — strips any PRIOR
// rookery mcp block (defensive: idempotent even if the real file itself somehow carries one), then
// appends a fresh block carrying the CURRENT bridge URL. A read failure (permission error, not-a-file,
// etc.) falls back to an empty base + a comment note rather than failing the turn.
function buildConfigToml(
  realCodexHome: string,
  bridgeUrl: string | undefined,
  managed: CodexRuntimeLaunchOptions | undefined,
): string {
  const base = loadBaseConfig(realCodexHome);
  assertNoManagedMcpCollisions(base, managed?.mcpServers ?? []);
  const blocks: string[] = [];
  if (bridgeUrl) blocks.push(`${ROOKERY_BLOCK_HEADER}\nurl = ${tomlString(bridgeUrl)}\n`);
  for (const skill of managed?.skills ?? []) {
    blocks.push(`[[skills.config]]\npath = ${tomlString(skill.path)}\nenabled = true\n`);
  }
  for (const server of managed?.mcpServers ?? []) {
    blocks.push(renderMcpServer(server.generatedName, server.config));
  }
  const generated = blocks.join("\n");
  if (!base) return generated;
  return generated ? `${base.replace(/\s*$/, "")}\n\n${generated}` : `${base.replace(/\s*$/, "")}\n`;
}

function writeConfigAtomically(configPath: string, content: string): void {
  const tmp = `${configPath}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  try {
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, configPath);
    fs.chmodSync(configPath, 0o600);
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort */ }
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlArray(values: string[]): string {
  return JSON.stringify(values);
}

function tomlKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : tomlString(value);
}

function tomlInlineTable(values: Record<string, string>): string {
  const entries = Object.entries(values)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${tomlKey(key)} = ${tomlString(value)}`);
  return `{ ${entries.join(", ")} }`;
}

function renderMcpCommon(config: CodexMcpConfig): string[] {
  return [
    "enabled = true",
    ...(config.required ? ["required = true"] : []),
    ...(config.startupTimeoutSec !== undefined ? [`startup_timeout_sec = ${config.startupTimeoutSec}`] : []),
    ...(config.toolTimeoutSec !== undefined ? [`tool_timeout_sec = ${config.toolTimeoutSec}`] : []),
    ...(config.enabledTools?.length ? [`enabled_tools = ${tomlArray(config.enabledTools)}`] : []),
    ...(config.disabledTools?.length ? [`disabled_tools = ${tomlArray(config.disabledTools)}`] : []),
  ];
}

function renderMcpServer(generatedName: string, config: CodexMcpConfig): string {
  const lines = [`[mcp_servers.${generatedName}]`];
  if (config.transport === "stdio") {
    lines.push(`command = ${tomlString(config.command)}`);
    if (config.args?.length) lines.push(`args = ${tomlArray(config.args)}`);
    if (config.cwd) lines.push(`cwd = ${tomlString(config.cwd)}`);
    if (config.env && Object.keys(config.env).length > 0) lines.push(`env = ${tomlInlineTable(config.env)}`);
    if (config.envVars?.length) lines.push(`env_vars = ${tomlArray(config.envVars)}`);
  } else {
    lines.push(`url = ${tomlString(config.url)}`);
    if (config.bearerTokenEnvVar) lines.push(`bearer_token_env_var = ${tomlString(config.bearerTokenEnvVar)}`);
    if (config.httpHeaders && Object.keys(config.httpHeaders).length > 0) {
      lines.push(`http_headers = ${tomlInlineTable(config.httpHeaders)}`);
    }
    if (config.envHttpHeaders && Object.keys(config.envHttpHeaders).length > 0) {
      lines.push(`env_http_headers = ${tomlInlineTable(config.envHttpHeaders)}`);
    }
  }
  lines.push(...renderMcpCommon(config));
  return `${lines.join("\n")}\n`;
}

function assertNoManagedMcpCollisions(
  base: string,
  servers: CodexRuntimeLaunchOptions["mcpServers"],
): void {
  const headers = base.split("\n").map((line) => line.trim());
  for (const server of servers) {
    const bare = `[mcp_servers.${server.generatedName}]`;
    const quoted = `[mcp_servers.${tomlString(server.generatedName)}]`;
    const bareSubtable = `[mcp_servers.${server.generatedName}.`;
    const quotedSubtable = `[mcp_servers.${tomlString(server.generatedName)}.`;
    if (headers.some((header) => header === bare || header === quoted || header.startsWith(bareSubtable) || header.startsWith(quotedSubtable))) {
      throw new Error(`managed Codex MCP server ${server.generatedName} collides with preserved native config`);
    }
  }
}

function loadBaseConfig(realCodexHome: string): string {
  const p = path.join(realCodexHome, "config.toml");
  if (!fs.existsSync(p)) return "";
  try {
    return stripRookeryBlock(fs.readFileSync(p, "utf8"));
  } catch (err) {
    return `# rookery: could not read ${p} (${String(err)}) — falling back to a minimal config\n`;
  }
}

// A dot after "rookery" scopes this to sub-tables of the rookery namespace specifically (e.g.
// `[mcp_servers.rookery.headers]`) — NOT an unrelated server whose name merely starts with the same
// prefix (e.g. a hypothetical `[mcp_servers.rookeryOther]`, which has no dot there and must survive).
const ROOKERY_SUBTABLE_PREFIX = "[mcp_servers.rookery.";

function isRookeryTableHeader(trimmed: string): boolean {
  return trimmed === ROOKERY_BLOCK_HEADER || trimmed.startsWith(ROOKERY_SUBTABLE_PREFIX);
}

// Removes the [mcp_servers.rookery] table AND any [mcp_servers.rookery.<...>] sub-table (P3-remaining
// Track A #4 — a hand-written `[mcp_servers.rookery.headers]` etc. would otherwise survive and
// orphan-attach to the freshly appended block) from TOML text. Textual, not a full TOML parser: each
// matched table's body runs until the next top-level `[...]` header or EOF — sufficient because this
// exact block is only ever written by rookery, in this exact shape.
function stripRookeryBlock(toml: string): string {
  const lines = toml.split("\n");
  const out: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (isRookeryTableHeader(trimmed)) {
      inBlock = true;
      continue;
    }
    if (inBlock && trimmed.startsWith("[")) inBlock = false;
    if (!inBlock) out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n"); // collapse gaps left by the removed block(s)
}
