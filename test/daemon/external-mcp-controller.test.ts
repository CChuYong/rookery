import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { ExternalMcpController } from "../../src/daemon/external-mcp-controller.js";
import type { BridgeToolDef } from "../../src/daemon/mcp-bridge.js";
import type { McpScope } from "../../src/core/settings.js";

function echoDefs(tag: string): BridgeToolDef[] {
  return [{
    name: "echo",
    description: `echo ${tag}`,
    inputSchema: { text: z.string() },
    handler: async (args) => {
      const { text } = args as unknown as { text: string };
      return { content: [{ type: "text", text: `${tag}:${text}` }] };
    },
  }];
}

function startServer(ctl: ExternalMcpController): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (ctl.handleHttp(req, res)) return;
    res.statusCode = 404;
    res.end("fallthrough");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ port, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

async function initialize(port: number, token: string): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp-ext/${token}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }),
  });
  return res.status;
}

describe("ExternalMcpController", () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  const tmpTokens: string[] = [];

  afterEach(async () => {
    for (const fn of cleanup.splice(0)) await fn();
    for (const p of tmpTokens.splice(0)) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
  });

  function makeController(scope: () => McpScope, defsScope: Exclude<McpScope, "off"> = "full") {
    const tokenPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rookery-mcp-")), "mcp-token");
    tmpTokens.push(tokenPath);
    const ctl = new ExternalMcpController({
      tokenPath, host: "127.0.0.1", port: () => 0,
      scope,
      defsFor: () => echoDefs(defsScope),
    });
    return { ctl, tokenPath };
  }

  it("off: status.url is null and /mcp-ext 404s (fail-closed)", async () => {
    const { ctl } = makeController(() => "off");
    ctl.reconcile();
    const { port, close } = await startServer(ctl);
    cleanup.push(close);
    expect(ctl.status()).toEqual({ scope: "off", url: null });
    // any token 404s because no session is registered
    expect(await initialize(port, "whatever")).toBe(404);
  });

  it("readonly/full: status.url is present and the pinned token from the file initializes", async () => {
    const { ctl, tokenPath } = makeController(() => "full");
    ctl.reconcile();
    const { port, close } = await startServer(ctl);
    cleanup.push(close);
    const s = ctl.status();
    expect(s.scope).toBe("full");
    expect(s.url).toContain("/mcp-ext/");
    const fileToken = fs.readFileSync(tokenPath, "utf8").trim();
    expect(s.url).toContain(fileToken);
    expect(await initialize(port, fileToken)).toBe(200);
  });

  it("regenerateToken rotates the secret: old token 404s, new url differs", async () => {
    const { ctl, tokenPath } = makeController(() => "full");
    ctl.reconcile();
    const { port, close } = await startServer(ctl);
    cleanup.push(close);
    const before = fs.readFileSync(tokenPath, "utf8").trim();
    const oldUrl = ctl.status().url;

    const after = ctl.regenerateToken();
    const newToken = fs.readFileSync(tokenPath, "utf8").trim();
    expect(newToken).not.toBe(before);
    expect(after.url).not.toBe(oldUrl);
    expect(after.url).toContain(newToken);
    // old token is gone
    expect(await initialize(port, before)).toBe(404);
    // new token works
    expect(await initialize(port, newToken)).toBe(200);
  });

  it("scope is resolved live: flipping off then reconcile tears the session down", async () => {
    let scope: McpScope = "full";
    const { ctl } = makeController(() => scope);
    ctl.reconcile();
    const { port, close } = await startServer(ctl);
    cleanup.push(close);
    const token = ctl.status().url!.split("/").pop()!;
    expect(await initialize(port, token)).toBe(200);

    scope = "off";
    ctl.reconcile();
    expect(ctl.status()).toEqual({ scope: "off", url: null });
    expect(await initialize(port, token)).toBe(404);
  });
});
