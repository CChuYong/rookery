// Live Slice 5 smoke: repo-shared discovery + real Claude/Codex workers + non-terminal reload.
// Requires working local provider auth and incurs a few small real-model turns. Everything
// Rookery owns is isolated under a temporary home/repository and removed in finally.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../dist/config.js";
import { startDaemon } from "../dist/daemon/server.js";
import { openDb } from "../dist/persistence/db.js";
import { Repositories } from "../dist/persistence/repositories.js";
import { connectDaemon } from "./demo/daemon-ws.mjs";

const TIMEOUT_MS = Number.parseInt(process.env.ROOKERY_SMOKE_TIMEOUT_MS ?? "", 10) || 480_000;
const CLAUDE_MODEL = process.env.ROOKERY_SMOKE_MODEL?.trim() || "claude-sonnet-4-6";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "rookery-capability-slice5-"));
const home = path.join(root, "home");
const repo = path.join(root, "repo");
const packRoot = path.join(repo, ".rookery", "capabilities", "team");
const instructionPath = path.join(packRoot, "instructions", "runtime.md");
const argvCapture = path.join(root, "codex-argv.jsonl");
const codexWrapper = path.join(root, "codex-wrapper.mjs");
const realCodexBin = execFileSync("which", ["codex"], { encoding: "utf8" }).trim();
const secretValue = `slice5-secret-${randomUUID()}`;
const markerOne = `SLICE5_REVISION_ONE_${randomUUID()}`;
const markerTwo = `SLICE5_REVISION_TWO_${randomUUID()}`;
const VALIDATE = "Execute CAPABILITY_SLICE5_VALIDATE now. Use the managed runtime_probe tool yourself and reply briefly.";
let daemon;
let client;

function log(message) {
  process.stderr.write(`[capability-slice5-smoke] ${message}\n`);
}

function write(filePath, content, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { mode });
}

function git(args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function worktreeCount() {
  return git(["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .length;
}

function makeConfig() {
  return loadConfig({
    ...process.env,
    ROOKERY_HOME: home,
    ROOKERY_PORT: "0",
    ROOKERY_WORKER_MODEL: CLAUDE_MODEL,
    ROOKERY_CCUSAGE_CMD: JSON.stringify([process.execPath, "-e", "process.stdout.write('[]')"]),
  });
}

async function waitUntil(check, label, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`timeout waiting for ${label}${lastError ? `: ${lastError}` : ""}`);
}

function workerResultCount(events, workerId) {
  return events.filter((event) => event.type === "worker.event" && event.workerId === workerId && event.data?.kind === "result").length;
}

async function waitForNextResult(events, workerId, previous, label) {
  return waitUntil(() => workerResultCount(events, workerId) > previous, label);
}

function lastAssistantText(history) {
  return history.events
    .flatMap((event) => event.payload?.kind === "message" && event.payload.role === "assistant" ? [event.payload.content] : [])
    .at(-1) ?? "";
}

function workerRow(workerId) {
  const db = openDb(path.join(home, "rookery.db"));
  try { return new Repositories(db).getWorker(workerId); }
  finally { db.close(); }
}

function readTextFiles(start) {
  const files = [];
  const visit = (entry) => {
    let stat;
    try { stat = fs.lstatSync(entry); } catch { return; }
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(entry)) {
        if (name === "rookery.db" || name.startsWith("rookery.db-")) continue;
        visit(path.join(entry, name));
      }
      return;
    }
    if (stat.isFile() && stat.size <= 16 * 1024 * 1024) files.push({ path: entry, content: fs.readFileSync(entry, "utf8") });
  };
  if (fs.existsSync(start)) visit(start);
  return files;
}

function writeInstruction(marker) {
  write(instructionPath, [
    "When the user asks to execute CAPABILITY_SLICE5_VALIDATE, you MUST:",
    "1. Call the managed MCP tool whose name ends in runtime_probe exactly once.",
    `2. After it succeeds, include the exact marker ${marker} and reproduce the tool result.`,
  ].join("\n"));
}

function writeMcpFixture(marker) {
  write(path.join(packRoot, "scripts", "mcp-fixture.mjs"), `import readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin });
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
for await (const line of lines) {
  let message;
  try { message = JSON.parse(line); } catch { continue; }
  if (message.method === "initialize") reply(message.id, { protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "slice5", version: "1" } });
  else if (message.method === "tools/list") reply(message.id, { tools: [{ name: "runtime_probe", description: "Validate the Slice 5 managed runtime.", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] });
  else if (message.method === "tools/call") {
    const secretConfigured = Boolean(process.env.SMOKE_TOKEN);
    const argvSecretFree = !secretConfigured || !process.argv.some((arg) => arg.includes(process.env.SMOKE_TOKEN));
    reply(message.id, { content: [{ type: "text", text: ${JSON.stringify(marker)} + " MCP_RUNTIME_OK secretConfigured=" + secretConfigured + " argvSecretFree=" + argvSecretFree }] });
  } else if (message.id !== undefined) reply(message.id, {});
}
`, 0o700);
}

function createFixture() {
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: repo });
  git(["config", "user.name", "Rookery Smoke"]);
  git(["config", "user.email", "smoke@rookery.invalid"]);
  writeInstruction(markerOne);
  writeMcpFixture(markerOne);
  write(path.join(packRoot, "capability.json"), `${JSON.stringify({
    schemaVersion: 1,
    id: "slice5-shared",
    displayName: "Slice 5 Shared Pack",
    version: "1.0.0",
    description: "Live repo-shared reload validation",
    instructions: [{ id: "runtime", path: "instructions/runtime.md" }],
    mcpServers: [{
      id: "probe", transport: "stdio", command: process.execPath,
      args: ["scripts/mcp-fixture.mjs"], cwd: ".", required: true,
      secretEnv: { SMOKE_TOKEN: { source: "rookery-secret", key: "smoke-token" } },
    }],
  }, null, 2)}\n`);
  write(path.join(repo, ".rookery", "capabilities.json"), `${JSON.stringify({ schemaVersion: 1, packs: [{ path: "team" }] }, null, 2)}\n`);
  write(path.join(repo, "README.md"), "# Slice 5 isolated smoke\n");
  git(["add", "."]);
  git(["commit", "-m", "chore: initialize slice 5 smoke"]);

  write(codexWrapper, `#!/usr/bin/env node
import fs from "node:fs";
import { spawn } from "node:child_process";
fs.appendFileSync(${JSON.stringify(argvCapture)}, JSON.stringify(process.argv.slice(2)) + "\\n", { mode: 0o600 });
const child = spawn(${JSON.stringify(realCodexBin)}, process.argv.slice(2), { stdio: "inherit", env: process.env });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { try { child.kill(signal); } catch {} });
child.on("error", (error) => { process.stderr.write(String(error)); process.exit(1); });
child.on("exit", (code, signal) => signal ? process.kill(process.pid, signal) : process.exit(code ?? 1));
`, 0o700);
}

async function libraryPack() {
  const response = await client.request({ type: "capabilities.library" });
  return response.library.packs.find((pack) => pack.sourceKind === "repo-shared");
}

async function assertWorkerResponse(events, workerId, marker, previousResults, label) {
  await waitForNextResult(events, workerId, previousResults, `${label} result`);
  const history = await client.request({ type: "worker.history", id: workerId });
  const text = lastAssistantText(history);
  for (const expected of [marker, "MCP_RUNTIME_OK", "secretConfigured=true", "argvSecretFree=true"]) {
    assert.ok(text.includes(expected), `${label} omitted ${expected}:\n${text}`);
  }
  return history;
}

async function sendAfterReload(workerId, text) {
  await waitUntil(async () => {
    try {
      await client.request({ type: "worker.send", id: workerId, text });
      return true;
    } catch (error) {
      if (/reload in progress/i.test(String(error))) return false;
      throw error;
    }
  }, `worker ${workerId} reload send gate`);
}

async function main() {
  assert.ok(fs.existsSync(path.join(process.cwd(), "dist", "daemon", "server.js")), "run npm run build before this smoke");
  createFixture();
  fs.mkdirSync(home, { recursive: true });
  const initialWorktrees = worktreeCount();
  const events = [];
  daemon = await startDaemon({ config: makeConfig(), acquireLock: false });
  client = await connectDaemon({ home, port: daemon.port });
  client.onEvent((event) => events.push(event));
  client.send({ type: "events.subscribe" });

  await client.request({ type: "settings.set", settings: { codexBin: codexWrapper } });
  const auth = await client.request({ type: "codex.authStatus" }, { timeoutMs: TIMEOUT_MS });
  assert.equal(auth.status?.ready, true, `Codex auth is not ready: ${JSON.stringify(auth.status)}`);
  const catalog = await client.request({ type: "codex.models.list" }, { timeoutMs: TIMEOUT_MS });
  assert.ok(catalog.models?.length, "Codex model catalog is unavailable");
  const requestedCodex = process.env.ROOKERY_SMOKE_CODEX_MODEL?.trim();
  const codexModel = requestedCodex || catalog.models.find((model) => model.isDefault)?.id || catalog.models[0].id;
  await client.request({ type: "settings.set", settings: { codexWorkerModel: codexModel, workerModel: CLAUDE_MODEL } });
  log(`using Claude ${CLAUDE_MODEL} and Codex ${codexModel}`);

  await client.request({ type: "repos.register", name: "slice5-smoke", path: repo, description: "isolated repo-shared smoke", base: "main" });
  const repos = await client.request({ type: "repos.list" });
  const repoId = repos.repos.find((entry) => entry.name === "slice5-smoke")?.id;
  assert.ok(repoId, "registered repo id is missing");
  const discovered = await waitUntil(async () => await libraryPack(), "repo-shared discovery", 20_000);
  assert.equal(discovered.status, "untrusted");
  await client.request({ type: "capabilities.trust.set", instanceId: discovered.instanceId, digest: discovered.digest, trusted: true });
  await client.request({ type: "capabilities.secret.set", instanceId: discovered.instanceId, key: "smoke-token", value: secretValue });
  await client.request({
    type: "capabilities.binding.set",
    id: "slice5-repo-shared",
    binding: {
      packInstanceId: discovered.instanceId, scopeKind: "repo-shared", scopeRef: repoId,
      audience: { agents: ["worker"], origins: ["ui"] }, enabled: true,
    },
  });
  log("repo-shared pack discovered, reviewed, secret configured, and bound");

  const claudeSpawn = await client.request({
    type: "fleet.spawn", repo: "slice5-smoke", label: "Slice 5 Claude", task: VALIDATE,
    model: CLAUDE_MODEL, provider: "claude",
  }, { timeoutMs: TIMEOUT_MS });
  const codexSpawn = await client.request({
    type: "fleet.spawn", repo: "slice5-smoke", label: "Slice 5 Codex", task: VALIDATE,
    model: codexModel, provider: "codex",
  }, { timeoutMs: TIMEOUT_MS });
  const claudeId = claudeSpawn.id;
  const codexId = codexSpawn.id;
  const claudeInitialHistory = await assertWorkerResponse(events, claudeId, markerOne, 0, "initial Claude worker");
  const codexInitialHistory = await assertWorkerResponse(events, codexId, markerOne, 0, "initial Codex worker");
  const claudeBefore = workerRow(claudeId);
  const codexBefore = workerRow(codexId);
  assert.ok(claudeBefore?.sdk_session_id && codexBefore?.sdk_session_id, "provider-native worker sessions were not persisted");
  const worktreesAfterSpawn = worktreeCount();
  assert.equal(worktreesAfterSpawn, initialWorktrees + 2, "spawning two workers did not create exactly two worktrees");
  log("both real provider workers applied revision one");

  writeInstruction(markerTwo);
  writeMcpFixture(markerTwo);
  const changed = await waitUntil(async () => {
    const pack = await libraryPack();
    return pack?.instanceId === discovered.instanceId && pack.digest !== discovered.digest && pack.status === "untrusted" ? pack : undefined;
  }, "watcher digest invalidation", 20_000);
  assert.equal(changed.secrets.find((secret) => secret.key === "smoke-token")?.configured, true);
  for (const workerId of [claudeId, codexId]) {
    const snapshot = (await client.request({ type: "capabilities.snapshot", target: { kind: "worker", id: workerId } })).snapshot;
    assert.equal(snapshot.desiredBlocked, true, `untrusted shared mutation did not block ${workerId}`);
  }
  await client.request({ type: "capabilities.trust.set", instanceId: changed.instanceId, digest: changed.digest, trusted: true });
  log("watcher observed mutation and exact-digest trust failed closed");

  const claudeReload = await client.request({ type: "capabilities.worker.reload", workerId: claudeId });
  assert.equal(claudeReload.mode, "reloading");

  const codexBusyBefore = workerResultCount(events, codexId);
  await client.request({ type: "worker.send", id: codexId, text: VALIDATE });
  const codexReload = await client.request({ type: "capabilities.worker.reload", workerId: codexId, whenIdle: true });
  assert.equal(codexReload.mode, "scheduled");
  await waitForNextResult(events, codexId, codexBusyBefore, "busy Codex turn before scheduled reload");
  log("Claude immediate reload and Codex when-idle reload accepted");

  const claudePostBefore = workerResultCount(events, claudeId);
  const codexPostBefore = workerResultCount(events, codexId);
  await sendAfterReload(claudeId, VALIDATE);
  await sendAfterReload(codexId, VALIDATE);
  const claudeFinalHistory = await assertWorkerResponse(events, claudeId, markerTwo, claudePostBefore, "reloaded Claude worker");
  const codexFinalHistory = await assertWorkerResponse(events, codexId, markerTwo, codexPostBefore, "reloaded Codex worker");

  const claudeAfter = workerRow(claudeId);
  const codexAfter = workerRow(codexId);
  for (const [before, after, label] of [[claudeBefore, claudeAfter, "Claude"], [codexBefore, codexAfter, "Codex"]]) {
    assert.equal(after?.sdk_session_id, before?.sdk_session_id, `${label} native session changed across reload`);
    assert.equal(after?.worktree_path, before?.worktree_path, `${label} worktree changed across reload`);
    assert.equal(after?.model, before?.model, `${label} model changed across reload`);
    assert.equal(after?.permission_mode, before?.permission_mode, `${label} permission changed across reload`);
  }
  assert.deepEqual(claudeFinalHistory.events.slice(0, claudeInitialHistory.events.length), claudeInitialHistory.events, "Claude transcript prefix changed");
  assert.deepEqual(codexFinalHistory.events.slice(0, codexInitialHistory.events.length), codexInitialHistory.events, "Codex transcript prefix changed");
  assert.equal(worktreeCount(), worktreesAfterSpawn, "reload created or removed a worktree");
  for (const workerId of [claudeId, codexId]) {
    const snapshot = (await client.request({ type: "capabilities.snapshot", target: { kind: "worker", id: workerId } })).snapshot;
    assert.equal(snapshot.desiredRevision, snapshot.appliedRevision, `${workerId} did not confirm the reloaded revision`);
    assert.equal(snapshot.desiredBlocked, false);
  }

  const serializedEvents = JSON.stringify(events);
  assert.ok(!serializedEvents.includes(secretValue), "secret leaked into live protocol events");
  for (const file of readTextFiles(home)) assert.ok(!file.content.includes(secretValue), `secret leaked into generated state: ${file.path}`);
  const argv = fs.readFileSync(argvCapture, "utf8");
  assert.ok(!argv.includes(secretValue), "secret leaked into Codex argv");
  assert.ok(argv.includes("features.shell_snapshot=false"), "secret-bearing Codex launch omitted shell-snapshot protection");
  log("identity, transcript, worktree, revision, and secret boundaries verified");

  await client.request({ type: "worker.delete", id: claudeId }, { timeoutMs: TIMEOUT_MS });
  await client.request({ type: "worker.delete", id: codexId }, { timeoutMs: TIMEOUT_MS });
  assert.equal(worktreeCount(), initialWorktrees, "worker cleanup left a worktree behind");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    claudeModel: CLAUDE_MODEL,
    codexModel,
    packInstanceId: discovered.instanceId,
    oldDigest: discovered.digest,
    newDigest: changed.digest,
    claudeWorkerId: claudeId,
    codexWorkerId: codexId,
    reloads: { claude: claudeReload.mode, codex: codexReload.mode },
    preserved: { nativeSessions: true, worktrees: true, transcripts: true, settings: true },
    secretFree: true,
  }, null, 2)}\n`);
}

try {
  await main();
} finally {
  client?.close();
  if (daemon) await daemon.close().catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
}
