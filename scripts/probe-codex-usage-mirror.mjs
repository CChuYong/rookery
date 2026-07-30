#!/usr/bin/env node
// Probe for the codex usage mirror (docs/superpowers/specs/2026-07-30-codex-usage-mirror-design.md).
//
// The mirror's whole safety argument rests on three codex-version-dependent facts that no unit test
// can cover, because they belong to the codex binary rather than to rookery:
//
//   1. a rollout under <CODEX_HOME>/archived_sessions/ is still counted by `ccusage codex daily`
//   2. it does NOT appear in `thread/list` (so the user's own resume/fork picker stays clean)
//   3. `thread/resume` on it is refused ("… is archived. Run `codex unarchive` …"), which is what keeps
//      the shared inode from acquiring a second writer
//
// (2) and (3) are what this probe checks, against whichever `codex` is on PATH. It builds two throwaway
// homes containing the SAME rollout — one under sessions/, one under archived_sessions/ — and compares
// what the app-server reports. Ground-truthed on codex-cli 0.145.0; re-run it when bumping codex.
//
//   node scripts/probe-codex-usage-mirror.mjs [path/to/rollout.jsonl]
//
// With no argument it picks the newest rollout out of <ROOKERY_HOME>/codex-homes. Nothing is written
// outside the temp directory it creates, and the real ~/.codex is never touched.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOKERY_HOME = process.env.ROOKERY_HOME ?? path.join(os.homedir(), ".rookery");

function newestRollout(root) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(p);
    }
  };
  walk(root);
  if (found.length === 0) return undefined;
  return found.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

function threadIdOf(rollout) {
  const firstLine = fs.readFileSync(rollout, "utf8").split("\n", 1)[0] ?? "";
  return JSON.parse(firstLine).payload?.id;
}

// Minimal newline-delimited JSON-RPC client over `codex app-server`, mirroring the handshake in
// src/core/codex/codex-backend.ts (initialize → initialized notification).
async function withAppServer(codexHome, fn) {
  const child = spawn(process.env.CODEX_BIN ?? "codex", ["app-server"], {
    env: { ...process.env, CODEX_HOME: codexHome },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let nextId = 1;
  const pending = new Map();
  createInterface({ input: child.stdout }).on("line", (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const entry = msg.id !== undefined ? pending.get(msg.id) : undefined;
    if (entry) { pending.delete(msg.id); entry(msg); }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    setTimeout(() => reject(new Error(`${method} timed out`)), 20_000);
  });
  try {
    await request("initialize", {
      clientInfo: { name: "rookery-probe", title: "rookery-probe", version: "0" },
      capabilities: { experimentalApi: false, requestAttestation: false },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`);
    return await fn(request);
  } finally {
    child.kill();
  }
}

async function inspect(label, home, rollout, subdir, threadId) {
  const dest = path.join(home, subdir, "2026", "07", "30", path.basename(rollout));
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  fs.copyFileSync(rollout, dest);
  return withAppServer(home, async (request) => {
    const list = await request("thread/list", {});
    const listed = JSON.stringify(list.result ?? list.error ?? {}).includes(threadId);
    const resumed = await request("thread/resume", { threadId });
    const refused = Boolean(resumed.error);
    console.log(`${label}`);
    console.log(`  thread/list contains the rollout : ${listed}`);
    console.log(`  thread/resume refused            : ${refused}${refused ? ` (${resumed.error.message.slice(0, 80)})` : ""}`);
    return { listed, refused };
  });
}

const rollout = process.argv[2] ?? newestRollout(path.join(ROOKERY_HOME, "codex-homes"));
if (!rollout || !fs.existsSync(rollout)) {
  console.error("no rollout to probe — pass one explicitly: node scripts/probe-codex-usage-mirror.mjs <rollout.jsonl>");
  process.exit(2);
}
const threadId = threadIdOf(rollout);
console.log(`rollout : ${rollout}`);
console.log(`thread  : ${threadId}\n`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rookery-mirror-probe-"));
try {
  const plain = await inspect("under sessions/ (what we must NOT do)", path.join(tmp, "plain"), rollout, "sessions", threadId);
  console.log("");
  const archived = await inspect("under archived_sessions/ (the mirror)", path.join(tmp, "archived"), rollout, "archived_sessions", threadId);

  const ok = plain.listed && !archived.listed && archived.refused;
  console.log(`\n${ok ? "PASS" : "FAIL"} — the mirror is ${ok ? "invisible to the picker and unresumable" : "NOT behaving as the design assumes; re-read the spec before shipping"}`);
  process.exit(ok ? 0 : 1);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
