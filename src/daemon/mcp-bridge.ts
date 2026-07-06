import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { ZodTypeAny } from "zod";

// Neutral, provider-agnostic tool definition carried across the bridge. Structurally compatible
// with the Claude Agent SDK's SdkMcpToolDefinition (name/description/zod-raw-shape/handler) — see
// src/tools/*-tools.ts — so the same objects that back Claude's in-process MCP servers can be
// re-registered here for codex sessions without conversion. `args` is typed `never` deliberately:
// the shape is only known at the zod-schema level (`inputSchema`), so callers must not construct
// arbitrary args by hand — the bridge is the only place that produces them, from the wire.
export interface BridgeToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: never, extra: unknown) => Promise<unknown>;
}

// The shape every tool result actually takes today (text-only content — see src/tools/*-tools.ts).
// `def.handler` is typed loosely (Promise<unknown>) at the neutral port boundary, so its resolved
// value is asserted back to this shape here, at the one place that hands it to the MCP SDK.
type BridgeCallResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

interface SessionEntry {
  token: string;
  defsProvider: () => BridgeToolDef[];
  // Live MCP transports for this rookery session, keyed by mcp-session-id. Normally at most one
  // (one bridge session per turn — see docs/2026-07-06-p2-codex-master.md), but nothing prevents a
  // client from opening more than one concurrently, so this is a map rather than a single slot.
  transports: Map<string, StreamableHTTPServerTransport>;
}

const DEFAULT_BASE_PATH = "/mcp";

// Daemon-hosted, stateful streamable-HTTP MCP bridge. Mounted on the EXISTING daemon http server
// (no new port, loopback-only) so a codex master's per-turn child process can reach rookery's
// in-process tool servers (memory/repos/fleet/schedule) the way the Claude Agent SDK reaches them
// in-process. This exact stateful transport pattern (per-mcp-session-id transports created on
// `initialize`) was verified LIVE against codex 0.142.5 — the model called a tool through it
// end-to-end (.superpowers/sdd/probe-mcp-bridge4.mjs). The stateless per-request pattern does NOT
// work with codex's rmcp client (the turn stalls waiting for tools/call) — do not "simplify" to it.
export class McpBridge {
  private readonly basePath: string;
  private readonly sessions = new Map<string, SessionEntry>(); // rookery sessionKey -> entry
  private readonly tokenIndex = new Map<string, string>(); // url token -> rookery sessionKey

  constructor(opts: { basePath?: string } = {}) {
    this.basePath = opts.basePath ?? DEFAULT_BASE_PATH;
  }

  // Registers (or re-registers) a rookery session on the bridge. The token is stable across calls
  // for the same sessionKey (so a session's URL never changes mid-lifetime); defsProvider is always
  // replaced so the caller can hand in a fresh per-turn closure — it is resolved again at the next
  // `initialize` (a live MCP session's tool list does not change mid-session; there is no MCP
  // "refresh tools" primitive, so per-turn freshness comes from one MCP session per turn).
  ensureSession(
    sessionKey: string,
    defsProvider: () => BridgeToolDef[],
  ): { url: (host: string, port: number) => string; token: string } {
    const existing = this.sessions.get(sessionKey);
    if (existing) {
      existing.defsProvider = defsProvider;
      return { url: (host, port) => this.buildUrl(host, port, existing.token), token: existing.token };
    }
    const token = randomUUID();
    this.sessions.set(sessionKey, { token, defsProvider, transports: new Map() });
    this.tokenIndex.set(token, sessionKey);
    return { url: (host, port) => this.buildUrl(host, port, token), token };
  }

  // Closes all live MCP transports for the session and forgets its token — subsequent requests to
  // its URL 404 (same as an unknown token; no oracle for "used to exist").
  release(sessionKey: string): void {
    const entry = this.sessions.get(sessionKey);
    if (!entry) return;
    for (const transport of entry.transports.values()) {
      transport.onclose = undefined; // avoid the transport re-deleting itself mid-iteration
      void transport.close().catch(() => {});
    }
    entry.transports.clear();
    this.tokenIndex.delete(entry.token);
    this.sessions.delete(sessionKey);
  }

  // Entry point wired into the daemon's existing http request listener (server.ts). Returns true
  // once the path is determined to fall under this bridge's basePath — including 404s for unknown
  // tokens and malformed sub-paths (which is also how OAuth discovery probes under the base path
  // are rejected) — so the caller falls through to its own routing only for genuinely unrelated
  // paths. The actual request handling (reading the body, delegating to a transport) is async and
  // intentionally not awaited here: this method's contract is synchronous route-matched-or-not.
  handleHttp(req: IncomingMessage, res: ServerResponse): boolean {
    const pathname = safePathname(req.url);
    if (pathname !== this.basePath && !pathname.startsWith(`${this.basePath}/`)) return false;

    const token = pathname === this.basePath ? "" : (pathname.slice(this.basePath.length + 1).split("/")[0] ?? "");
    const sessionKey = token ? this.tokenIndex.get(token) : undefined;
    const entry = sessionKey ? this.sessions.get(sessionKey) : undefined;
    if (!entry) {
      res.statusCode = 404;
      res.end();
      return true;
    }

    // Never let a rejected promise escape the http layer as an unhandled rejection or a thrown error.
    this.dispatch(req, res, entry).catch((err: unknown) => {
      // PICKUP (Task 1 review M1): log before responding — a swallowed dispatch error previously left
      // no trace anywhere, which made a live codex-turn stall against the bridge nearly undiagnosable.
      console.error("[mcp-bridge]", err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end();
      }
    });
    return true;
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse, entry: SessionEntry): Promise<void> {
    const body = await readBody(req);
    const parsedBody = body ? safeJsonParse(body) : undefined;
    const rpcMethod = isRecord(parsedBody) ? parsedBody.method : undefined;

    const sid = firstHeader(req.headers["mcp-session-id"]);
    const known = sid ? entry.transports.get(sid) : undefined;
    if (known) {
      await known.handleRequest(req, res, parsedBody);
      return;
    }

    if (req.method !== "POST" || rpcMethod !== "initialize") {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "no session" }));
      return;
    }

    let transport: StreamableHTTPServerTransport;
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        entry.transports.set(id, transport);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) entry.transports.delete(transport.sessionId);
    };
    await this.connectServer(transport, entry.defsProvider());
    await transport.handleRequest(req, res, parsedBody);
  }

  // Builds a fresh McpServer for one MCP session, registering `defs` resolved AT CONNECT time (the
  // per-turn freshness point — see ensureSession). Tool names are registered as-is (no `<group>__`
  // prefixing): the spec's decision is that collisions are impossible today across our tool groups
  // (all names are already globally unique), guarded here at dev time.
  private async connectServer(transport: StreamableHTTPServerTransport, defs: BridgeToolDef[]): Promise<void> {
    const mcp = new McpServer({ name: "rookery", version: "1.0.0" });
    const seen = new Set<string>();
    for (const def of defs) {
      if (seen.has(def.name)) throw new Error(`mcp-bridge: duplicate tool name "${def.name}"`);
      seen.add(def.name);
      mcp.registerTool(
        def.name,
        { description: def.description, inputSchema: def.inputSchema as Record<string, ZodTypeAny> },
        async (args, extra): Promise<BridgeCallResult> => {
          try {
            const result = await def.handler(args as never, extra);
            return result as BridgeCallResult;
          } catch (err) {
            // Handler exceptions must never throw through the http layer — they become a normal
            // (http 200) tool result the model sees as an error.
            const message = err instanceof Error ? err.message : String(err);
            return { content: [{ type: "text", text: `tool error: ${message}` }], isError: true };
          }
        },
      );
    }
    await mcp.connect(transport);
  }

  private buildUrl(host: string, port: number, token: string): string {
    return `http://${host}:${port}${this.basePath}/${token}`;
  }
}

function safePathname(url: string | undefined): string {
  try {
    return new URL(url ?? "/", "http://localhost").pathname;
  } catch {
    return "/";
  }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer | string) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function safeJsonParse(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
