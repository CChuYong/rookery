// Live Slice 8 smoke: lightweight MCP/Skill Catalog registration and repository quick binding.
// Uses the production daemon and WebSocket protocol without launching a model provider.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../dist/config.js";
import { startDaemon } from "../dist/daemon/server.js";
import { connectDaemon } from "./demo/daemon-ws.mjs";

const keepFixture = process.env.ROOKERY_SMOKE_KEEP === "1";
const root = process.env.ROOKERY_SMOKE_ROOT?.trim() || fs.mkdtempSync(path.join(os.tmpdir(), "rookery-capability-slice8-"));
const home = path.join(root, "home");
const repo = path.join(root, "repo");
const skill = path.join(root, "skill");
const secretValue = `slice8-secret-${randomUUID()}`;
const responses = [];
let daemon;
let client;

function log(message) {
  process.stderr.write(`[capability-slice8-smoke] ${message}\n`);
}

function write(filePath, content, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { mode });
}

function config() {
  return loadConfig({
    ...process.env,
    ROOKERY_HOME: home,
    ROOKERY_PORT: "0",
    ROOKERY_CCUSAGE_CMD: JSON.stringify([process.execPath, "-e", "process.stdout.write('[]')"]),
  });
}

async function request(message) {
  const response = await client.request(message);
  responses.push(response);
  return response;
}

function readableFiles(start) {
  const files = [];
  const visit = (entry) => {
    const stat = fs.lstatSync(entry);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(entry)) visit(path.join(entry, name));
      return;
    }
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) return;
    if (path.basename(entry) === "rookery.db" || path.basename(entry).startsWith("rookery.db-")) return;
    files.push({ path: entry, content: fs.readFileSync(entry, "utf8") });
  };
  if (fs.existsSync(start)) visit(start);
  return files;
}

async function main() {
  assert.ok(fs.existsSync(path.join(process.cwd(), "dist", "daemon", "server.js")), "run npm run build before this smoke");
  fs.mkdirSync(repo, { recursive: true });
  write(path.join(repo, "README.md"), "# Slice 8 smoke\n");
  write(path.join(skill, "SKILL.md"), "---\nname: smoke-review\ndescription: Review the Slice 8 smoke fixture\n---\n\nReview carefully.\n");
  fs.mkdirSync(home, { recursive: true });

  daemon = await startDaemon({ config: config(), acquireLock: false });
  client = await connectDaemon({ home, port: daemon.port });
  await request({ type: "repos.register", name: "slice8-smoke", path: repo, description: "isolated Catalog smoke" });
  const repoList = await request({ type: "repos.list" });
  const repoId = repoList.repos.find((entry) => entry.name === "slice8-smoke")?.id;
  assert.ok(repoId, "registered repository id is missing");

  const mcpCreated = await request({
    type: "capabilities.mcp.create",
    input: {
      id: "slice8-docs",
      displayName: "Slice 8 Docs",
      description: "Single MCP Catalog entry",
      mcpServer: {
        id: "docs",
        transport: "streamable-http",
        url: "https://example.test/mcp",
        auth: { bearerToken: { source: "rookery-secret", key: "docs-token" } },
      },
      secretValues: { "docs-token": secretValue },
    },
  });
  const skillCreated = await request({
    type: "capabilities.skill.create",
    input: { id: "smoke-review", displayName: "Smoke Review", description: "Single Skill Catalog entry", sourcePath: skill },
  });
  const mcpPack = mcpCreated.pack;
  const skillPack = skillCreated.pack;
  assert.equal(mcpPack.status, "untrusted");
  assert.equal(skillPack.status, "untrusted");
  assert.equal(mcpPack.manifest.mcpServers.length, 1);
  assert.equal(skillPack.manifest.skills.length, 1);

  let library = (await request({ type: "capabilities.library" })).library;
  assert.equal(library.bindings.filter((binding) => binding.packInstanceId === mcpPack.instanceId || binding.packInstanceId === skillPack.instanceId).length, 0, "Catalog registration unexpectedly created a binding");
  log("registered unbound singleton MCP and Skill entries");

  await request({ type: "capabilities.trust.set", instanceId: mcpPack.instanceId, digest: mcpPack.digest, trusted: true });
  await request({ type: "capabilities.trust.set", instanceId: skillPack.instanceId, digest: skillPack.digest, trusted: true });
  for (const packInstanceId of [mcpPack.instanceId, skillPack.instanceId]) {
    const enabled = await request({
      type: "capabilities.binding.quickSet",
      input: { packInstanceId, scopeKind: "repo-local", scopeRef: repoId, mode: "enabled", agents: ["master", "worker"] },
    });
    assert.equal(enabled.binding.enabled, true);
    assert.deepEqual(enabled.binding.audience, { agents: ["master", "worker"], origins: ["ui"] });
  }
  const disabled = await request({
    type: "capabilities.binding.quickSet",
    input: { packInstanceId: mcpPack.instanceId, scopeKind: "repo-local", scopeRef: repoId, mode: "disabled", agents: ["worker"] },
  });
  assert.equal(disabled.binding.enabled, false);
  assert.deepEqual(disabled.binding.audience.agents, ["worker"]);
  const inherited = await request({
    type: "capabilities.binding.quickSet",
    input: { packInstanceId: mcpPack.instanceId, scopeKind: "repo-local", scopeRef: repoId, mode: "inherit", agents: [] },
  });
  assert.equal(inherited.binding, null);

  library = (await request({ type: "capabilities.library" })).library;
  assert.equal(library.bindings.some((binding) => binding.packInstanceId === mcpPack.instanceId && binding.scopeKind === "repo-local" && binding.scopeRef === repoId), false);
  assert.equal(library.bindings.some((binding) => binding.packInstanceId === skillPack.instanceId && binding.scopeKind === "repo-local" && binding.scopeRef === repoId && binding.enabled), true);
  assert.equal(JSON.stringify(responses).includes(secretValue), false, "secret value leaked into a WebSocket response");
  const leakedFile = readableFiles(home).find((file) => file.content.includes(secretValue));
  assert.equal(leakedFile, undefined, `secret value leaked into ${leakedFile?.path}`);
  log("trusted, enabled, disabled, inherited, and verified the write-only secret boundary");
}

try {
  await main();
  log("PASS");
} finally {
  client?.close();
  if (daemon) await daemon.close();
  if (keepFixture) log(`kept fixture at ${root}`);
  else fs.rmSync(root, { recursive: true, force: true });
}
