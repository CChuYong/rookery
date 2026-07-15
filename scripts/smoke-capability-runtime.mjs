// Live Slice 3 smoke: real Claude master + worker, isolated Rookery home/repo/pack.
// This intentionally uses the production daemon and SDK. It requires working Claude auth and
// incurs a small real-model cost. No user/repository Claude configuration is written.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { loadConfig } from "../dist/config.js";
import { startDaemon } from "../dist/daemon/server.js";
import { connectDaemon } from "./demo/daemon-ws.mjs";

const MODEL = process.env.ROOKERY_SMOKE_MODEL?.trim() || "claude-sonnet-4-6";
const TIMEOUT_MS = Number.parseInt(process.env.ROOKERY_SMOKE_TIMEOUT_MS ?? "", 10) || 360_000;
const VALIDATION_REQUEST = "Execute the managed Slice 3 validation procedure. Do it yourself and do not spawn another worker.";
const EXPECTED_MARKERS = [
  "INSTRUCTION_RUNTIME_OK",
  "SKILL_RUNTIME_OK",
  "MCP_RUNTIME_OK",
  "secretConfigured=true",
  "argvSecretFree=true",
];

const root = fs.mkdtempSync(path.join(os.tmpdir(), "rookery-capability-smoke-"));
const home = path.join(root, "home");
const repo = path.join(root, "repo");
const packRoot = path.join(root, "pack");
const secretValue = `slice3-secret-${randomUUID()}`;
let daemon;
let client;

function log(message) {
  process.stderr.write(`[capability-smoke] ${message}\n`);
}

function write(filePath, content, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { mode });
}

function git(args, cwd = repo) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
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
    ROOKERY_MASTER_MODEL: MODEL,
    ROOKERY_WORKER_MODEL: MODEL,
    // Keep the unrelated usage collector local and deterministic during the smoke.
    ROOKERY_CCUSAGE_CMD: JSON.stringify([
      process.execPath,
      "-e",
      "process.stdout.write('[]')",
    ]),
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

function assertMarkers(text, label) {
  for (const marker of EXPECTED_MARKERS) {
    assert.ok(text.includes(marker), `${label} omitted ${marker}:\n${text}`);
  }
}

function assertRuntimeTools(events, target) {
  const names = events.flatMap((event) => {
    if (target.kind === "master" && event.type === "master.tool" && event.sessionId === target.id && event.phase === "start") {
      return [event.name];
    }
    if (target.kind === "worker" && event.type === "worker.event" && event.workerId === target.id && event.data?.kind === "tool_use") {
      return [event.data.name];
    }
    return [];
  });
  assert.ok(names.some((name) => name === "Skill" || name.endsWith(":runtime-check")), `${target.kind} did not invoke the managed skill: ${names.join(", ")}`);
  assert.ok(names.some((name) => name.includes("runtime_probe")), `${target.kind} did not invoke the managed MCP tool: ${names.join(", ")}`);
}

function assertAppliedSnapshot(snapshot, revision, label) {
  assert.equal(snapshot.desiredRevision, revision, `${label} desired revision drifted`);
  assert.equal(snapshot.appliedRevision, revision, `${label} applied revision drifted`);
  for (const kind of ["instruction", "skill", "mcp"]) {
    assert.ok(
      snapshot.entries.some((entry) => entry.managed && entry.kind === kind && entry.state === "applied"),
      `${label} has no applied managed ${kind}`,
    );
  }
}

function readRuntimeFiles(runtimeRoot) {
  const files = [];
  const visit = (entry) => {
    const stat = fs.statSync(entry);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(entry)) visit(path.join(entry, name));
    } else if (stat.isFile()) {
      files.push({ path: entry, content: fs.readFileSync(entry, "utf8") });
    }
  };
  visit(runtimeRoot);
  return files;
}

function createFixture() {
  fs.mkdirSync(repo, { recursive: true });
  git(["init", "-b", "main"]);
  git(["config", "user.name", "Rookery Smoke"]);
  git(["config", "user.email", "smoke@rookery.invalid"]);
  write(path.join(repo, "README.md"), "# Slice 3 isolated smoke\n");
  git(["add", "README.md"]);
  git(["commit", "-m", "chore: initialize smoke repo"]);

  write(
    path.join(packRoot, "instructions", "runtime.md"),
    [
      "When the user asks to execute the managed Slice 3 validation procedure, you MUST:",
      "1. Invoke the Skill tool for `runtime-check`; do not merely describe the skill.",
      "2. Follow that skill through its MCP call.",
      "3. Only after both complete, include `INSTRUCTION_RUNTIME_OK` in the final response.",
    ].join("\n"),
  );
  write(
    path.join(packRoot, "skills", "runtime-check", "SKILL.md"),
    [
      "---",
      "name: runtime-check",
      "description: Run when asked to execute the managed Slice 3 validation procedure.",
      "---",
      "Call the MCP tool whose name ends in `runtime_probe` exactly once.",
      "After its successful result, include `SKILL_RUNTIME_OK` and reproduce the MCP result in your final response.",
    ].join("\n"),
  );
  write(
    path.join(packRoot, "scripts", "mcp-fixture.mjs"),
    `import readline from "node:readline";

const lines = readline.createInterface({ input: process.stdin });
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
for await (const line of lines) {
  let message;
  try { message = JSON.parse(line); } catch { continue; }
  if (message.method === "initialize") {
    reply(message.id, {
      protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "rookery-slice3-smoke", version: "1.0.0" },
    });
  } else if (message.method === "tools/list") {
    reply(message.id, { tools: [{
      name: "runtime_probe",
      description: "Validate the isolated Rookery capability runtime.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    }] });
  } else if (message.method === "tools/call") {
    const configured = Boolean(process.env.SMOKE_TOKEN);
    const argvSecretFree = !configured || !process.argv.some((arg) => arg.includes(process.env.SMOKE_TOKEN));
    reply(message.id, { content: [{
      type: "text",
      text: \`MCP_RUNTIME_OK secretConfigured=\${configured} argvSecretFree=\${argvSecretFree}\`,
    }] });
  } else if (message.id !== undefined) {
    reply(message.id, {});
  }
}
`,
    0o700,
  );
  write(
    path.join(packRoot, "capability.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      id: "slice3-smoke",
      displayName: "Slice 3 Smoke",
      version: "1.0.0",
      description: "Harmless isolated live runtime validation.",
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
    }, null, 2)}\n`,
  );
}

async function connect(handle, events) {
  const next = await connectDaemon({ home, port: handle.port });
  next.onEvent((event) => events.push(event));
  next.send({ type: "events.subscribe" });
  return next;
}

async function main() {
  assert.ok(fs.existsSync(path.join(process.cwd(), "dist", "daemon", "server.js")), "run npm run build before this smoke");
  createFixture();
  fs.mkdirSync(home, { recursive: true });
  log(`starting isolated daemon with ${MODEL}`);

  const firstEvents = [];
  daemon = await startDaemon({ config: makeConfig(), acquireLock: false });
  client = await connect(daemon, firstEvents);

  await client.request({ type: "repos.register", name: "slice3-smoke", path: repo, description: "isolated smoke", base: "main" });
  const added = await client.request({ type: "capabilities.pack.add", path: packRoot });
  const pack = added.pack;
  assert.ok(pack?.instanceId && pack?.digest, "pack registration failed");
  await client.request({ type: "capabilities.trust.set", instanceId: pack.instanceId, digest: pack.digest, trusted: true });
  await client.request({ type: "capabilities.secret.set", instanceId: pack.instanceId, key: "smoke-token", value: secretValue });
  await client.request({
    type: "capabilities.binding.set",
    id: "slice3-smoke-rookery",
    binding: {
      packInstanceId: pack.instanceId,
      scopeKind: "rookery",
      scopeRef: "",
      audience: { agents: ["master", "worker"], origins: ["ui"] },
      enabled: true,
    },
  });
  log("pack registered, trusted, secret configured, and bound");

  const created = await client.request({ type: "session.create", cwd: repo, provider: "claude" });
  const sessionId = created.sessionId;
  await client.request({ type: "session.rename", sessionId, label: "Slice 3 master smoke" });
  await client.request(
    { type: "session.send", sessionId, text: VALIDATION_REQUEST, model: MODEL },
    { timeoutMs: TIMEOUT_MS },
  );
  await waitUntil(
    () => firstEvents.find((event) => event.type === "master.result" && event.sessionId === sessionId),
    "master result",
  );
  const masterHistory = await client.request({ type: "session.history", sessionId });
  const masterText = masterHistory.events
    .flatMap((event) => event.type === "master.message" && event.payload?.role === "assistant" ? [event.payload.content] : [])
    .join("\n");
  assertMarkers(masterText, "master response");
  assertRuntimeTools(firstEvents, { kind: "master", id: sessionId });
  log("master loaded instruction + skill + MCP");

  const masterRuntime = await waitUntil(
    () => firstEvents.find((event) => event.type === "capabilities.runtime" && event.targetKind === "master" && event.targetId === sessionId && event.state === "current"),
    "master applied runtime",
  );
  const revision = masterRuntime.desiredRevision;
  const masterSnapshot = (await client.request({ type: "capabilities.snapshot", target: { kind: "session", id: sessionId } })).snapshot;
  assertAppliedSnapshot(masterSnapshot, revision, "master");

  const runtimeRoot = path.join(home, "capability-runtime", revision);
  assert.ok(fs.existsSync(path.join(runtimeRoot, ".complete.json")), "immutable runtime marker is missing");
  const runtimeFiles = readRuntimeFiles(runtimeRoot);
  assert.ok(runtimeFiles.some((file) => file.path.endsWith(".mcp.json") && file.content.includes("${ROOKERY_CAP_SECRET_")), "generated MCP config has no secret alias");
  assert.ok(runtimeFiles.every((file) => !file.content.includes(secretValue)), "secret value leaked into a runtime file");
  log("immutable runtime and secret boundary verified");

  const initialWorktrees = worktreeCount();
  assert.equal(initialWorktrees, 1, "smoke repo should start with one worktree");
  const spawned = await client.request({
    type: "fleet.spawn",
    repo: "slice3-smoke",
    label: "Slice 3 worker smoke",
    task: VALIDATION_REQUEST,
    model: MODEL,
    provider: "claude",
  }, { timeoutMs: TIMEOUT_MS });
  const workerId = spawned.id;
  await waitUntil(
    () => firstEvents.find((event) => event.type === "worker.event" && event.workerId === workerId && event.data?.kind === "result"),
    "initial worker result",
  );
  const workerHistory = await client.request({ type: "worker.history", id: workerId });
  const workerText = workerHistory.events
    .flatMap((event) => event.payload?.kind === "message" && event.payload.role === "assistant" ? [event.payload.content] : [])
    .join("\n");
  assertMarkers(workerText, "worker response");
  assertRuntimeTools(firstEvents, { kind: "worker", id: workerId });
  const workerRuntime = await waitUntil(
    () => firstEvents.find((event) => event.type === "capabilities.runtime" && event.targetKind === "worker" && event.targetId === workerId && event.state === "current"),
    "initial worker applied runtime",
  );
  const workerRevision = workerRuntime.desiredRevision;
  const workerSnapshot = (await client.request({ type: "capabilities.snapshot", target: { kind: "worker", id: workerId } })).snapshot;
  assertAppliedSnapshot(workerSnapshot, workerRevision, "worker");
  const workerRuntimeRoot = path.join(home, "capability-runtime", workerRevision);
  assert.ok(fs.existsSync(path.join(workerRuntimeRoot, ".complete.json")), "worker immutable runtime marker is missing");
  assert.ok(readRuntimeFiles(workerRuntimeRoot).every((file) => !file.content.includes(secretValue)), "secret value leaked into a worker runtime file");
  assert.equal(worktreeCount(), initialWorktrees + 1, "initial worker should create exactly one worktree");
  log("worker initial stream loaded the same runtime revision");

  client.close();
  client = undefined;
  await daemon.close();
  daemon = undefined;

  const secondEvents = [];
  daemon = await startDaemon({ config: makeConfig(), acquireLock: false });
  client = await connect(daemon, secondEvents);
  assert.equal(worktreeCount(), initialWorktrees + 1, "daemon restart created an extra worktree");
  log("daemon restarted; lazily resuming the persisted worker");
  await client.request({ type: "worker.send", id: workerId, text: VALIDATION_REQUEST }, { timeoutMs: TIMEOUT_MS });
  await waitUntil(
    () => secondEvents.find((event) => event.type === "worker.event" && event.workerId === workerId && event.data?.kind === "result"),
    "resumed worker result",
  );
  const resumedHistory = await client.request({ type: "worker.history", id: workerId });
  const resumedText = resumedHistory.events
    .flatMap((event) => event.payload?.kind === "message" && event.payload.role === "assistant" ? [event.payload.content] : [])
    .at(-1) ?? "";
  assertMarkers(resumedText, "resumed worker response");
  assertRuntimeTools(secondEvents, { kind: "worker", id: workerId });
  const resumedRuntime = await waitUntil(
    () => secondEvents.find((event) => event.type === "capabilities.runtime" && event.targetKind === "worker" && event.targetId === workerId && event.state === "current"),
    "resumed worker applied runtime",
  );
  assert.equal(resumedRuntime.desiredRevision, workerRevision, "resumed worker compiled a different revision");
  const resumedSnapshot = (await client.request({ type: "capabilities.snapshot", target: { kind: "worker", id: workerId } })).snapshot;
  assertAppliedSnapshot(resumedSnapshot, workerRevision, "resumed worker");
  assert.equal(worktreeCount(), initialWorktrees + 1, "lazy resume created an extra worktree");
  log("worker lazy resume reused the revision and worktree");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    model: MODEL,
    masterRevision: revision,
    workerRevision,
    masterSessionId: sessionId,
    workerId,
    worktrees: worktreeCount(),
    runtimeFiles: runtimeFiles.length,
  }, null, 2)}\n`);
}

try {
  await main();
} finally {
  client?.close();
  if (daemon) await daemon.close().catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
}
