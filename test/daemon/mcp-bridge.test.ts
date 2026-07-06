import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpBridge, type BridgeToolDef } from "../../src/daemon/mcp-bridge.js";

// Starts a plain node http server that delegates to bridge.handleHttp, mirroring the exact wiring
// pattern server.ts will use: bridge gets first refusal, unmatched paths fall through to a 404.
function startHttpServer(bridge: McpBridge): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (!bridge.handleHttp(req, res)) {
      res.statusCode = 404;
      res.end("not a bridge path");
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ port, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

function echoDef(tag: string): BridgeToolDef {
  return {
    name: "echo",
    description: `echoes back its input (${tag})`,
    inputSchema: { text: z.string() },
    handler: async (args) => {
      const { text } = args as unknown as { text: string };
      return { content: [{ type: "text", text: `${tag}:${text}` }] };
    },
  };
}

function throwingDef(): BridgeToolDef {
  return {
    name: "boom",
    description: "always throws",
    inputSchema: {},
    handler: async () => {
      throw new Error("kaboom");
    },
  };
}

async function connectClient(url: string): Promise<Client> {
  const client = new Client({ name: "test-client", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  await client.connect(transport);
  return client;
}

describe("McpBridge", () => {
  let cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanup.map((fn) => fn()));
    cleanup = [];
  });

  it("round-trips initialize/list/call over the stateful transport", async () => {
    const bridge = new McpBridge({});
    const { port, close } = await startHttpServer(bridge);
    cleanup.push(close);

    const { url } = bridge.ensureSession("session-a", () => [echoDef("a")]);
    const client = await connectClient(url("127.0.0.1", port));
    cleanup.push(() => client.close());

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(["echo"]);

    const result = await client.callTool({ name: "echo", arguments: { text: "hi" } });
    expect(result.content).toEqual([{ type: "text", text: "a:hi" }]);
  });

  it("isolates two sessions: each token only sees its own defs", async () => {
    const bridge = new McpBridge({});
    const { port, close } = await startHttpServer(bridge);
    cleanup.push(close);

    const a = bridge.ensureSession("session-a", () => [echoDef("a")]);
    const b = bridge.ensureSession("session-b", () => [{ ...echoDef("b"), name: "shout" }]);
    expect(a.token).not.toBe(b.token);

    const clientA = await connectClient(a.url("127.0.0.1", port));
    cleanup.push(() => clientA.close());
    const clientB = await connectClient(b.url("127.0.0.1", port));
    cleanup.push(() => clientB.close());

    const toolsA = await clientA.listTools();
    const toolsB = await clientB.listTools();
    expect(toolsA.tools.map((t) => t.name)).toEqual(["echo"]);
    expect(toolsB.tools.map((t) => t.name)).toEqual(["shout"]);

    const resultA = await clientA.callTool({ name: "echo", arguments: { text: "x" } });
    expect(resultA.content).toEqual([{ type: "text", text: "a:x" }]);
  });

  it("returns 404 for an unknown token (no oracle)", async () => {
    const bridge = new McpBridge({});
    const { port, close } = await startHttpServer(bridge);
    cleanup.push(close);
    bridge.ensureSession("session-a", () => [echoDef("a")]);

    const res = await fetch(`http://127.0.0.1:${port}/mcp/not-a-real-token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(404);
  });

  it("returns false (falls through) for a path outside the base path", async () => {
    const bridge = new McpBridge({});
    const { port, close } = await startHttpServer(bridge);
    cleanup.push(close);

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("not a bridge path");
  });

  it("converts a handler throw into an isError tool result, never a thrown http error", async () => {
    const bridge = new McpBridge({});
    const { port, close } = await startHttpServer(bridge);
    cleanup.push(close);

    const { url } = bridge.ensureSession("session-a", () => [throwingDef()]);
    const client = await connectClient(url("127.0.0.1", port));
    cleanup.push(() => client.close());

    const result = await client.callTool({ name: "boom", arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "tool error: kaboom" }]);
  });

  it("release() closes the session's transports; further requests 404", async () => {
    const bridge = new McpBridge({});
    const { port, close } = await startHttpServer(bridge);
    cleanup.push(close);

    const { url, token } = bridge.ensureSession("session-a", () => [echoDef("a")]);
    const client = await connectClient(url("127.0.0.1", port));
    await client.listTools();

    bridge.release("session-a");

    const res = await fetch(`http://127.0.0.1:${port}/mcp/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(404);
  });

  it("re-resolves defsProvider across connects: a second initialize sees mutated defs", async () => {
    const bridge = new McpBridge({});
    const { port, close } = await startHttpServer(bridge);
    cleanup.push(close);

    let defs: BridgeToolDef[] = [echoDef("v1")];
    const { url } = bridge.ensureSession("session-a", () => defs);

    const client1 = await connectClient(url("127.0.0.1", port));
    const tools1 = await client1.listTools();
    expect(tools1.tools.map((t) => t.name)).toEqual(["echo"]);
    await client1.close();

    // Mutate the def list — the NEXT mcp session (new initialize) should see the new tool.
    defs = [{ ...echoDef("v2"), name: "echo2" }];

    const client2 = await connectClient(url("127.0.0.1", port));
    cleanup.push(() => client2.close());
    const tools2 = await client2.listTools();
    expect(tools2.tools.map((t) => t.name)).toEqual(["echo2"]);
  });
});
