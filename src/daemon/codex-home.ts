import fs from "node:fs";
import path from "node:path";

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
}

// Per-session CODEX_HOME directory rookery materializes for a codex master turn. Called fresh on
// every ensureSession (i.e. every turn): idempotent, so re-materializing never accumulates duplicate
// config blocks and a user's live edit to their real config.toml propagates on the session's NEXT
// turn (documented risk — see the spec's Risks section).
export function materializeCodexHome(rookeryHome: string, sessionKey: string, bridgeUrl: string, opts: MaterializeCodexHomeOpts): string {
  const dir = codexHomeDirFor(rookeryHome, sessionKey);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700); // repair mode if the dir pre-existed with a looser mode (mkdirSync's mode is only applied on creation)
  } catch {
    /* best-effort */
  }

  const configPath = path.join(dir, "config.toml");
  fs.writeFileSync(configPath, buildConfigToml(opts.realCodexHome, bridgeUrl), { mode: 0o600 });
  try {
    fs.chmodSync(configPath, 0o600); // repair mode if the file pre-existed (writeFileSync's mode only applies on creation)
  } catch {
    /* best-effort */
  }

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
  const src = path.join(rookeryHome, "codex-homes", sourceSessionId, "sessions");
  if (!fs.existsSync(src)) return;
  const dst = path.join(rookeryHome, "codex-homes", newSessionId, "sessions");
  fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
  fs.cpSync(src, dst, { recursive: true });
}

// Best-effort cleanup on session delete (item 6) — never throws. Removes the whole per-session
// CODEX_HOME (config.toml + auth.json + any codex-written rollout/session state under it).
export function removeCodexHome(rookeryHome: string, sessionKey: string): void {
  try {
    fs.rmSync(codexHomeDirFor(rookeryHome, sessionKey), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

function codexHomeDirFor(rookeryHome: string, sessionKey: string): string {
  return path.join(rookeryHome, "codex-homes", sessionKey);
}

// Starts from the user's real config.toml (if present) — preserving model_providers/base_url/etc, so a
// minimal rookery-only config doesn't silently drop the user's customizations — strips any PRIOR
// rookery mcp block (defensive: idempotent even if the real file itself somehow carries one), then
// appends a fresh block carrying the CURRENT bridge URL. A read failure (permission error, not-a-file,
// etc.) falls back to an empty base + a comment note rather than failing the turn.
function buildConfigToml(realCodexHome: string, bridgeUrl: string): string {
  const base = loadBaseConfig(realCodexHome);
  const rookeryBlock = `${ROOKERY_BLOCK_HEADER}\nurl = "${bridgeUrl}"\n`;
  return base ? `${base.replace(/\s*$/, "")}\n\n${rookeryBlock}` : rookeryBlock;
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

// Removes a [mcp_servers.rookery] table from TOML text. Textual, not a full TOML parser: a table body
// runs until the next top-level `[...]` header or EOF — sufficient because this exact block is only
// ever written by rookery, in this exact shape.
function stripRookeryBlock(toml: string): string {
  const lines = toml.split("\n");
  const out: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === ROOKERY_BLOCK_HEADER) {
      inBlock = true;
      continue;
    }
    if (inBlock && trimmed.startsWith("[")) inBlock = false;
    if (!inBlock) out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n"); // collapse gaps left by the removed block
}
