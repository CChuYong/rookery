// Live Slice 9 smoke: Rookery defaults and non-mutating, scope-only Effective previews.
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
const root = process.env.ROOKERY_SMOKE_ROOT?.trim() || fs.mkdtempSync(path.join(os.tmpdir(), "rookery-capability-slice9-"));
const home = path.join(root, "home");
const repo = path.join(root, "repo");
const secretValue = `slice9-secret-${randomUUID()}`;
const responses = [];
let daemon;
let client;

function log(message) {
  process.stderr.write(`[capability-slice9-smoke] ${message}\n`);
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
  fs.writeFileSync(path.join(repo, "README.md"), "# Slice 9 smoke\n");
  fs.mkdirSync(home, { recursive: true });

  daemon = await startDaemon({ config: config(), acquireLock: false });
  client = await connectDaemon({ home, port: daemon.port });
  await request({ type: "repos.register", name: "slice9-smoke", path: repo, description: "isolated scope preview smoke" });

  const created = await request({
    type: "capabilities.mcp.create",
    input: {
      id: "slice9-docs",
      displayName: "Slice 9 Docs",
      description: "Scope preview MCP entry",
      mcpServer: {
        id: "docs",
        transport: "streamable-http",
        url: "https://example.test/mcp",
        auth: { bearerToken: { source: "rookery-secret", key: "docs-token" } },
      },
      secretValues: { "docs-token": secretValue },
    },
  });
  const pack = created.pack;
  await request({ type: "capabilities.trust.set", instanceId: pack.instanceId, digest: pack.digest, trusted: true });
  const enabled = await request({
    type: "capabilities.binding.quickSet",
    input: {
      packInstanceId: pack.instanceId,
      scopeKind: "rookery",
      scopeRef: "",
      mode: "enabled",
      agents: ["master"],
    },
  });
  assert.equal(enabled.binding.scopeKind, "rookery");
  assert.deepEqual(enabled.binding.audience, { agents: ["master"], origins: ["ui"] });

  const libraryBefore = (await request({ type: "capabilities.library" })).library;
  const master = await request({
    type: "capabilities.snapshot",
    target: { kind: "rookery", provider: "claude", agent: "master" },
  });
  const worker = await request({
    type: "capabilities.snapshot",
    target: { kind: "rookery", provider: "claude", agent: "worker" },
  });
  const libraryAfter = (await request({ type: "capabilities.library" })).library;

  assert.equal(master.snapshot.target.kind, "rookery");
  assert.equal(master.snapshot.target.cwd, null);
  assert.equal(master.snapshot.appliedRevision, undefined);
  assert.ok(master.snapshot.entries.some((entry) => entry.managed?.packId === "slice9-docs" && entry.state === "desired"));
  assert.equal(master.snapshot.entries.some((entry) => entry.state === "applied"), false);
  assert.equal(master.snapshot.entries.some((entry) => entry.invocation), false);
  assert.equal(worker.snapshot.entries.some((entry) => entry.managed?.packId === "slice9-docs"), false);
  assert.deepEqual(libraryAfter, libraryBefore, "preview requests mutated the capability Library");
  assert.equal(fs.existsSync(path.join(home, "capability-runtime")), false, "preview materialized a capability runtime");
  assert.equal(fs.existsSync(path.join(home, "codex-homes")), false, "preview materialized a Codex home");

  await assert.rejects(
    client.request({
      type: "capabilities.snapshot",
      target: { kind: "rookery", provider: "claude", agent: "master", cwd: repo },
    }),
    /unrecognized|invalid|request/i,
  );
  assert.equal(JSON.stringify(responses).includes(secretValue), false, "secret value leaked into a WebSocket response");
  const leakedFile = readableFiles(home).find((file) => file.content.includes(secretValue));
  assert.equal(leakedFile, undefined, `secret value leaked into ${leakedFile?.path}`);
  log("Rookery default and Master/Worker preview boundaries verified");
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
