// Live Slice 4 smoke: real Codex master + worker, isolated Rookery home/repo/packs.
// Requires working Codex auth and incurs a few small real-model turns. The script fingerprints
// the user's real Codex config/auth before and after and removes every temporary artifact.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { codexSecretEnvName } from "../dist/core/codex/codex-capabilities.js";
import { loadConfig } from "../dist/config.js";
import { startDaemon } from "../dist/daemon/server.js";
import { connectDaemon } from "./demo/daemon-ws.mjs";

const TIMEOUT_MS = Number.parseInt(process.env.ROOKERY_SMOKE_TIMEOUT_MS ?? "", 10) || 480_000;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "rookery-codex-capability-smoke-"));
const home = path.join(root, "home");
const repo = path.join(root, "repo");
const packRoot = path.join(root, "pack-common");
const targetPackRoot = path.join(root, "pack-target");
const argvCapture = path.join(root, "codex-argv.jsonl");
const codexWrapper = path.join(root, "codex-smoke-wrapper.mjs");
const realCodexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const realCodexBin = execFileSync("which", ["codex"], { encoding: "utf8" }).trim();
const secretValue = `slice4-common-secret-${randomUUID()}`;
const targetSecretValue = `slice4-target-secret-${randomUUID()}`;
const instructionMarker = `INSTRUCTION_RUNTIME_OK_${randomUUID()}`;
const skillMarker = `SKILL_RUNTIME_OK_${randomUUID()}`;
const forkMemory = `FORK_MEMORY_${randomUUID()}`;
const VALIDATION_REQUEST = "Execute the managed Slice 4 validation procedure using the runtime-check skill. Do not spawn another agent.";
let daemon;
let client;

function log(message) {
  process.stderr.write(`[codex-capability-smoke] ${message}\n`);
}

function write(filePath, content, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { mode });
}

function git(args, cwd = repo) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function fingerprint(filePath) {
  if (!fs.existsSync(filePath)) return { exists: false };
  const stat = fs.statSync(filePath);
  return {
    exists: true,
    mode: stat.mode & 0o777,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    hash: sha256(fs.readFileSync(filePath)),
  };
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
    ROOKERY_CCUSAGE_CMD: JSON.stringify([process.execPath, "-e", "process.stdout.write('[]')"]),
  });
}

async function waitUntil(predicate, label, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timeout waiting for ${label}`);
}

function assistantText(history, kind) {
  if (kind === "master") {
    return history.events
      .flatMap((event) => event.type === "master.message" && event.payload?.role === "assistant" ? [event.payload.content] : [])
      .join("\n");
  }
  return history.events
    .flatMap((event) => event.payload?.kind === "message" && event.payload.role === "assistant" ? [event.payload.content] : [])
    .join("\n");
}

function lastAssistantText(history) {
  return history.events
    .flatMap((event) => event.payload?.kind === "message" && event.payload.role === "assistant" ? [event.payload.content] : [])
    .at(-1) ?? "";
}

function assertMarkers(text, label) {
  for (const marker of [instructionMarker, skillMarker, "MCP_RUNTIME_OK", "secretConfigured=true", "argvSecretFree=true", "cwdConfigured=true"]) {
    assert.ok(text.includes(marker), `${label} omitted ${marker}:\n${text}`);
  }
}

function assertMcpTool(events, kind, id) {
  const names = events.flatMap((event) => {
    if (kind === "master" && event.type === "master.tool" && event.sessionId === id && event.phase === "start") return [event.name];
    if (kind === "worker" && event.type === "worker.event" && event.workerId === id && event.data?.kind === "tool_use") return [event.data.name];
    return [];
  });
  assert.ok(names.some((name) => name.includes("runtime_probe")), `${kind} did not invoke runtime_probe: ${names.join(", ")}`);
}

function assertAppliedSnapshot(snapshot, revision, label) {
  assert.equal(snapshot.target.provider, "codex", `${label} provider drifted`);
  assert.equal(snapshot.desiredRevision, revision, `${label} desired revision drifted`);
  assert.equal(snapshot.appliedRevision, revision, `${label} applied revision drifted`);
  for (const kind of ["instruction", "skill", "mcp"]) {
    assert.ok(snapshot.entries.some((entry) => entry.managed && entry.kind === kind && entry.state === "applied"), `${label} has no applied managed ${kind}`);
  }
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
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) return;
    files.push({ path: entry, content: fs.readFileSync(entry, "utf8") });
  };
  if (fs.existsSync(start)) visit(start);
  return files;
}

function rolloutIds(homePath) {
  const sessions = path.join(homePath, "sessions");
  const ids = [];
  for (const file of readTextFiles(sessions)) {
    if (!file.path.endsWith(".jsonl")) continue;
    const first = file.content.split("\n", 1)[0];
    try {
      const parsed = JSON.parse(first);
      if (parsed.type === "session_meta" && typeof parsed.payload?.id === "string") ids.push(parsed.payload.id);
    } catch { /* ignore non-rollout text */ }
  }
  return ids.sort();
}

function assertSecretFree(files, label) {
  for (const file of files) {
    assert.ok(!file.content.includes(secretValue), `${label} leaked the common secret in ${file.path}`);
    assert.ok(!file.content.includes(targetSecretValue), `${label} leaked the target secret in ${file.path}`);
  }
}

function createCodexWrapper() {
  write(codexWrapper, `#!/usr/bin/env node
import fs from "node:fs";
import { spawn } from "node:child_process";
fs.appendFileSync(${JSON.stringify(argvCapture)}, JSON.stringify(process.argv.slice(2)) + "\\n", { mode: 0o600 });
const child = spawn(${JSON.stringify(realCodexBin)}, process.argv.slice(2), { stdio: "inherit", env: process.env });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { try { child.kill(signal); } catch {} });
child.on("error", (error) => { process.stderr.write(String(error)); process.exit(1); });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
`, 0o700);
}

function createMcpFixture(rootPath) {
  write(path.join(rootPath, "scripts", "mcp-fixture.mjs"), `import fs from "node:fs";
import readline from "node:readline";

const lines = readline.createInterface({ input: process.stdin });
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
for await (const line of lines) {
  let message;
  try { message = JSON.parse(line); } catch { continue; }
  const target = process.env.SMOKE_MODE === "target";
  const tool = target ? "target_probe" : "runtime_probe";
  if (message.method === "initialize") {
    reply(message.id, {
      protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "rookery-slice4-smoke", version: "1.0.0" },
    });
  } else if (message.method === "tools/list") {
    reply(message.id, { tools: [{
      name: tool,
      description: target ? "Target-only isolation probe." : "Validate the managed Codex runtime.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    }] });
  } else if (message.method === "tools/call") {
    const secret = target ? process.env.TARGET_TOKEN : process.env.SMOKE_TOKEN;
    const argvSecretFree = !secret || !process.argv.some((arg) => arg.includes(secret));
    const cwdConfigured = fs.existsSync("capability.json");
    reply(message.id, { content: [{
      type: "text",
      text: (target ? "TARGET_RUNTIME_OK" : "MCP_RUNTIME_OK")
        + " secretConfigured=" + Boolean(secret)
        + " argvSecretFree=" + argvSecretFree
        + " cwdConfigured=" + cwdConfigured,
    }] });
  } else if (message.id !== undefined) {
    reply(message.id, {});
  }
}
`, 0o700);
}

function createFixtures() {
  fs.mkdirSync(repo, { recursive: true });
  git(["init", "-b", "main"]);
  git(["config", "user.name", "Rookery Smoke"]);
  git(["config", "user.email", "smoke@rookery.invalid"]);
  write(path.join(repo, "README.md"), "# Slice 4 isolated Codex smoke\n");
  git(["add", "README.md"]);
  git(["commit", "-m", "chore: initialize smoke repo"]);

  write(path.join(packRoot, "instructions", "runtime.md"), [
    "When asked to execute the managed Slice 4 validation procedure, you MUST:",
    "1. Load and follow the `runtime-check` skill; do not infer or invent its private marker.",
    "2. Invoke the MCP tool whose name ends in `runtime_probe` exactly once.",
    `3. Only after both complete, include \`${instructionMarker}\` in the final response.`,
  ].join("\n"));
  write(path.join(packRoot, "skills", "runtime-check", "SKILL.md"), [
    "---",
    "name: runtime-check",
    "description: Run when asked to execute the managed Slice 4 validation procedure.",
    "---",
    "Call the managed MCP tool whose name ends in `runtime_probe` exactly once.",
    `After it succeeds, include the private marker \`${skillMarker}\` and reproduce its result.`,
  ].join("\n"));
  createMcpFixture(packRoot);
  write(path.join(packRoot, "capability.json"), `${JSON.stringify({
    schemaVersion: 1,
    id: "slice4-smoke",
    displayName: "Slice 4 Codex Smoke",
    version: "1.0.0",
    description: "Harmless isolated live Codex runtime validation.",
    instructions: [{ id: "runtime", path: "instructions/runtime.md" }],
    skills: [{ id: "runtime-check", path: "skills/runtime-check" }],
    mcpServers: [{
      id: "probe",
      transport: "stdio",
      command: process.execPath,
      args: ["scripts/mcp-fixture.mjs"],
      cwd: ".",
      required: true,
      secretEnv: { SMOKE_TOKEN: { source: "rookery-secret", key: "smoke-token" } },
    }],
  }, null, 2)}\n`);

  createMcpFixture(targetPackRoot);
  write(path.join(targetPackRoot, "capability.json"), `${JSON.stringify({
    schemaVersion: 1,
    id: "slice4-target",
    displayName: "Slice 4 Target-only Pack",
    version: "1.0.0",
    description: "Target-specific isolation proof.",
    mcpServers: [{
      id: "target",
      transport: "stdio",
      command: process.execPath,
      args: ["scripts/mcp-fixture.mjs"],
      cwd: ".",
      env: { SMOKE_MODE: "target" },
      secretEnv: { TARGET_TOKEN: { source: "rookery-secret", key: "target-token" } },
    }],
  }, null, 2)}\n`);
  createCodexWrapper();
}

async function connect(handle, events) {
  const next = await connectDaemon({ home, port: handle.port });
  next.onEvent((event) => events.push(event));
  next.send({ type: "events.subscribe" });
  return next;
}

async function addTrustedPack(packPath, secretKey, value) {
  const added = await client.request({ type: "capabilities.pack.add", path: packPath });
  const pack = added.pack;
  assert.ok(pack?.instanceId && pack?.digest, `pack registration failed: ${packPath}`);
  await client.request({ type: "capabilities.trust.set", instanceId: pack.instanceId, digest: pack.digest, trusted: true });
  await client.request({ type: "capabilities.secret.set", instanceId: pack.instanceId, key: secretKey, value });
  return pack;
}

async function main() {
  assert.ok(fs.existsSync(path.join(process.cwd(), "dist", "daemon", "server.js")), "run npm run build before this smoke");
  const realBefore = {
    config: fingerprint(path.join(realCodexHome, "config.toml")),
    auth: fingerprint(path.join(realCodexHome, "auth.json")),
  };
  createFixtures();
  fs.mkdirSync(home, { recursive: true });
  const initialWorktrees = worktreeCount();

  const firstEvents = [];
  log("starting isolated daemon and probing Codex auth/model catalog");
  daemon = await startDaemon({ config: makeConfig(), acquireLock: false });
  client = await connect(daemon, firstEvents);
  await client.request({ type: "settings.set", settings: { codexBin: codexWrapper } });
  const auth = await client.request({ type: "codex.authStatus" }, { timeoutMs: TIMEOUT_MS });
  assert.equal(auth.status?.ready, true, `Codex auth is not ready: ${JSON.stringify(auth.status)}`);
  const catalog = await client.request({ type: "codex.models.list" }, { timeoutMs: TIMEOUT_MS });
  assert.ok(catalog.models?.length, "Codex model catalog is unavailable");
  const requestedModel = process.env.ROOKERY_SMOKE_CODEX_MODEL?.trim();
  const model = requestedModel || catalog.models.find((entry) => entry.isDefault)?.id || catalog.models[0].id;
  assert.ok(catalog.models.some((entry) => entry.id === model), `requested model is not in the live catalog: ${model}`);
  await client.request({ type: "settings.set", settings: { codexMasterModel: model, codexWorkerModel: model } });
  log(`using ${model}`);

  await client.request({ type: "repos.register", name: "slice4-smoke", path: repo, description: "isolated smoke", base: "main" });
  const commonPack = await addTrustedPack(packRoot, "smoke-token", secretValue);
  const targetPack = await addTrustedPack(targetPackRoot, "target-token", targetSecretValue);
  await client.request({
    type: "capabilities.binding.set",
    id: "slice4-smoke-rookery",
    binding: {
      packInstanceId: commonPack.instanceId,
      scopeKind: "rookery",
      scopeRef: "",
      audience: { agents: ["master", "worker"], origins: ["ui"] },
      enabled: true,
    },
  });
  log("packs registered; common pack trusted, secret configured, and globally bound");

  const created = await client.request({ type: "session.create", cwd: repo, provider: "codex" });
  const sessionId = created.sessionId;
  await client.request({ type: "session.send", sessionId, text: VALIDATION_REQUEST }, { timeoutMs: TIMEOUT_MS });
  await waitUntil(() => firstEvents.find((event) => event.type === "master.result" && event.sessionId === sessionId), "Codex master result");
  const masterHistory = await client.request({ type: "session.history", sessionId });
  assertMarkers(assistantText(masterHistory, "master"), "master response");
  assertMcpTool(firstEvents, "master", sessionId);
  const masterRuntime = await waitUntil(
    () => firstEvents.find((event) => event.type === "capabilities.runtime" && event.targetKind === "master" && event.targetId === sessionId && event.state === "current"),
    "master applied runtime",
  );
  const masterSnapshot = (await client.request({ type: "capabilities.snapshot", target: { kind: "session", id: sessionId } })).snapshot;
  assertAppliedSnapshot(masterSnapshot, masterRuntime.desiredRevision, "master");
  log("Codex master loaded managed instruction + skill + MCP");

  const spawned = await client.request({
    type: "fleet.spawn",
    repo: "slice4-smoke",
    label: "Slice 4 Codex worker smoke",
    task: `${VALIDATION_REQUEST} Remember this exact value for later: ${forkMemory}`,
    provider: "codex",
  }, { timeoutMs: TIMEOUT_MS });
  const sourceWorkerId = spawned.id;
  await waitUntil(() => firstEvents.find((event) => event.type === "worker.event" && event.workerId === sourceWorkerId && event.data?.kind === "result"), "initial Codex worker result");
  const sourceHistory = await client.request({ type: "worker.history", id: sourceWorkerId });
  assertMarkers(assistantText(sourceHistory, "worker"), "initial worker response");
  assertMcpTool(firstEvents, "worker", sourceWorkerId);
  const sourceRuntime = await waitUntil(
    () => firstEvents.find((event) => event.type === "capabilities.runtime" && event.targetKind === "worker" && event.targetId === sourceWorkerId && event.state === "current"),
    "initial worker applied runtime",
  );
  const sourceSnapshot = (await client.request({ type: "capabilities.snapshot", target: { kind: "worker", id: sourceWorkerId } })).snapshot;
  assertAppliedSnapshot(sourceSnapshot, sourceRuntime.desiredRevision, "source worker");
  assert.equal(worktreeCount(), initialWorktrees + 1, "source worker did not create exactly one worktree");

  const masterHome = path.join(home, "codex-homes", sessionId);
  const sourceHome = path.join(home, "codex-homes", `worker-${sourceWorkerId}`);
  assert.ok(fs.existsSync(path.join(masterHome, "config.toml")), "master target home is missing");
  assert.ok(fs.existsSync(path.join(sourceHome, "config.toml")), "worker target home is missing");
  assert.notEqual(masterHome, sourceHome);
  const commonAlias = codexSecretEnvName(commonPack.instanceId, { source: "rookery-secret", key: "smoke-token" });
  const masterConfig = fs.readFileSync(path.join(masterHome, "config.toml"), "utf8");
  const sourceConfig = fs.readFileSync(path.join(sourceHome, "config.toml"), "utf8");
  assert.ok(masterConfig.includes("[mcp_servers.rookery]"), "master config omitted the bridge");
  assert.ok(!sourceConfig.includes("[mcp_servers.rookery]"), "worker config received the master bridge");
  assert.ok(masterConfig.includes(commonAlias) && sourceConfig.includes(commonAlias), "common secret alias was not lowered");
  assertSecretFree(readTextFiles(path.join(home, "capability-runtime")), "immutable runtime");
  assertSecretFree([{ path: "master config", content: masterConfig }, { path: "source config", content: sourceConfig }], "target config");
  log("distinct master/worker homes and generated secret boundary verified");

  client.close();
  client = undefined;
  await daemon.close();
  daemon = undefined;
  write(path.join(home, "codex-homes", "orphan-master", "config.toml"), "# orphan\n");
  write(path.join(home, "codex-homes", "worker-orphan", "config.toml"), "# orphan\n");

  const secondEvents = [];
  daemon = await startDaemon({ config: makeConfig(), acquireLock: false });
  client = await connect(daemon, secondEvents);
  assert.ok(!fs.existsSync(path.join(home, "codex-homes", "orphan-master")), "boot GC retained orphan master home");
  assert.ok(!fs.existsSync(path.join(home, "codex-homes", "worker-orphan")), "boot GC retained orphan worker home");
  assert.ok(fs.existsSync(masterHome) && fs.existsSync(sourceHome), "boot GC removed an authoritative home");
  assert.equal(worktreeCount(), initialWorktrees + 1, "daemon restart created a duplicate worktree");
  log("boot GC removed only orphan homes; lazily resuming source worker");

  await client.request({ type: "worker.send", id: sourceWorkerId, text: `${VALIDATION_REQUEST} Also state the exact FORK_MEMORY value you remember.` }, { timeoutMs: TIMEOUT_MS });
  await waitUntil(() => secondEvents.find((event) => event.type === "worker.event" && event.workerId === sourceWorkerId && event.data?.kind === "result"), "resumed worker result");
  const resumedHistory = await client.request({ type: "worker.history", id: sourceWorkerId });
  const resumedText = lastAssistantText(resumedHistory);
  assertMarkers(resumedText, "resumed worker response");
  assert.ok(resumedText.includes(forkMemory), `resumed worker lost native context:\n${resumedText}`);
  assertMcpTool(secondEvents, "worker", sourceWorkerId);
  const resumedRuntime = await waitUntil(
    () => secondEvents.find((event) => event.type === "capabilities.runtime" && event.targetKind === "worker" && event.targetId === sourceWorkerId && event.state === "current"),
    "resumed worker applied runtime",
  );
  assert.equal(resumedRuntime.desiredRevision, sourceRuntime.desiredRevision, "source worker revision changed across restart");

  // A source-only fake rollout proves the native fork copier selects the returned rollout ancestry
  // instead of cloning every conversation that happens to exist in the source home.
  const unrelatedRolloutId = `unrelated-${randomUUID()}`;
  write(
    path.join(sourceHome, "sessions", "9999", "12", "31", "rollout-unrelated.jsonl"),
    `${JSON.stringify({ type: "session_meta", payload: { id: unrelatedRolloutId } })}\n`,
  );
  const forked = await client.request({ type: "worker.fork", id: sourceWorkerId }, { timeoutMs: TIMEOUT_MS });
  const targetWorkerId = forked.id;
  const targetHome = path.join(home, "codex-homes", `worker-${targetWorkerId}`);
  assert.ok(fs.existsSync(path.join(targetHome, "sessions")), "native fork did not seed target rollout state");
  assert.ok(!rolloutIds(targetHome).includes(unrelatedRolloutId), "target worker received an unrelated source rollout");

  await client.request({
    type: "capabilities.binding.set",
    id: "slice4-target-worker-only",
    binding: {
      packInstanceId: targetPack.instanceId,
      scopeKind: "worker",
      scopeRef: targetWorkerId,
      audience: { agents: ["worker"], origins: ["ui"] },
      enabled: true,
    },
  });
  await client.request({ type: "worker.send", id: targetWorkerId, text: `${VALIDATION_REQUEST} State the exact FORK_MEMORY value from the source conversation.` }, { timeoutMs: TIMEOUT_MS });
  await waitUntil(() => secondEvents.find((event) => event.type === "worker.event" && event.workerId === targetWorkerId && event.data?.kind === "result"), "forked worker result");
  const targetHistory = await client.request({ type: "worker.history", id: targetWorkerId });
  const targetText = lastAssistantText(targetHistory);
  assertMarkers(targetText, "forked worker response");
  assert.ok(targetText.includes(forkMemory), `forked worker lost native context:\n${targetText}`);
  assertMcpTool(secondEvents, "worker", targetWorkerId);
  const targetRuntime = await waitUntil(
    () => secondEvents.find((event) => event.type === "capabilities.runtime" && event.targetKind === "worker" && event.targetId === targetWorkerId && event.state === "current"),
    "forked worker applied runtime",
  );
  assert.notEqual(targetRuntime.desiredRevision, sourceRuntime.desiredRevision, "target-specific binding did not change the target revision");
  const targetSnapshot = (await client.request({ type: "capabilities.snapshot", target: { kind: "worker", id: targetWorkerId } })).snapshot;
  assertAppliedSnapshot(targetSnapshot, targetRuntime.desiredRevision, "fork target");
  assert.ok(targetSnapshot.entries.some((entry) => entry.managed && entry.kind === "mcp" && entry.name.includes("target")), "target-only MCP is absent");
  const sourceAfterFork = (await client.request({ type: "capabilities.snapshot", target: { kind: "worker", id: sourceWorkerId } })).snapshot;
  assert.ok(!sourceAfterFork.entries.some((entry) => entry.managed && entry.name.includes("target")), "source worker observed target-only binding");

  const targetConfig = fs.readFileSync(path.join(targetHome, "config.toml"), "utf8");
  const sourceConfigAfterFork = fs.readFileSync(path.join(sourceHome, "config.toml"), "utf8");
  const targetAlias = codexSecretEnvName(targetPack.instanceId, { source: "rookery-secret", key: "target-token" });
  assert.ok(targetConfig.includes("rookery__slice4_target__target") && targetConfig.includes(targetAlias), "target config omitted target-only MCP/alias");
  assert.ok(!sourceConfigAfterFork.includes("rookery__slice4_target__target") && !sourceConfigAfterFork.includes(targetAlias), "source config observed target-only MCP/alias");
  assertSecretFree([{ path: "target config", content: targetConfig }, { path: "source config", content: sourceConfigAfterFork }], "isolated worker configs");
  assert.equal(worktreeCount(), initialWorktrees + 2, "native fork did not create exactly one additional worktree");
  log("native fork preserved context, copied selected ancestry, and recompiled target-only bindings");

  const capturedEvents = JSON.stringify([...firstEvents, ...secondEvents]);
  assert.ok(!capturedEvents.includes(secretValue) && !capturedEvents.includes(targetSecretValue), "secret leaked into protocol events");
  assertSecretFree(readTextFiles(home), "Rookery generated state/logs");
  const argvLines = fs.readFileSync(argvCapture, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(argvLines.length >= 4, "Codex argv wrapper captured too few child launches");
  const secretSafeArgs = [
    "app-server",
    "-c",
    "features.shell_snapshot=false",
    "-c",
    'shell_environment_policy.exclude=["ROOKERY_CAP_SECRET_*"]',
  ];
  assert.ok(argvLines.some((args) => JSON.stringify(args) === JSON.stringify(secretSafeArgs)), "no managed-secret launch carried the safety policy");
  for (const args of argvLines) {
    assert.ok(
      JSON.stringify(args) === JSON.stringify(["app-server"]) || JSON.stringify(args) === JSON.stringify(secretSafeArgs),
      `unexpected Codex argv: ${JSON.stringify(args)}`,
    );
  }
  assertSecretFree([{ path: argvCapture, content: fs.readFileSync(argvCapture, "utf8") }], "Codex argv capture");

  await client.request({ type: "worker.delete", id: targetWorkerId }, { timeoutMs: TIMEOUT_MS });
  assert.ok(!fs.existsSync(targetHome), "target worker home survived permanent delete");
  assert.ok(fs.existsSync(sourceHome), "target deletion removed the source worker home");
  await client.request({ type: "worker.delete", id: sourceWorkerId }, { timeoutMs: TIMEOUT_MS });
  assert.ok(!fs.existsSync(sourceHome), "source worker home survived permanent delete");
  await client.request({ type: "session.delete", sessionId }, { timeoutMs: TIMEOUT_MS });
  assert.ok(!fs.existsSync(masterHome), "master home survived permanent delete");
  assert.equal(worktreeCount(), initialWorktrees, "worker cleanup left a git worktree behind");

  client.close();
  client = undefined;
  await daemon.close();
  daemon = undefined;
  const realAfter = {
    config: fingerprint(path.join(realCodexHome, "config.toml")),
    auth: fingerprint(path.join(realCodexHome, "auth.json")),
  };
  assert.deepEqual(realAfter, realBefore, "the user's real Codex config/auth metadata changed");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    codexVersion: execFileSync(realCodexBin, ["--version"], { encoding: "utf8" }).trim(),
    model,
    masterRevision: masterRuntime.desiredRevision,
    sourceWorkerRevision: sourceRuntime.desiredRevision,
    targetWorkerRevision: targetRuntime.desiredRevision,
    masterSessionId: sessionId,
    sourceWorkerId,
    targetWorkerId,
    argvLaunches: argvLines.length,
    userCodexHomeUnchanged: true,
    cleanupVerified: true,
  }, null, 2)}\n`);
}

try {
  await main();
} finally {
  client?.close();
  if (daemon) await daemon.close().catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
}
