import type { IncomingMessage, ServerResponse } from "node:http";
import { McpBridge } from "./mcp-bridge.js";
import type { BridgeToolDef } from "./mcp-bridge.js";
import { loadOrCreateToken, rotateToken } from "./auth.js";
import type { McpScope } from "../core/settings.js";

// Fixed bridge sessionKey for the single external exposure. Namespace-isolated from codex session ids
// (which are rookery session UUIDs), so it can never collide with the codex `/mcp` bridge's entries.
const EXTERNAL_MCP_KEY = "external";

export interface ExternalMcpStatus {
  scope: McpScope;
  url: string | null; // null when off (or before the first reconcile)
}

export interface ExternalMcpControllerDeps {
  tokenPath: string; // ~/.rookery/mcp-token (0600, persisted so the URL survives daemon restarts)
  host: string; // config.host — the host component of the advertised URL
  port: () => number; // reads the REAL bound port (server.ts boundPort, ephemeral-safe) at status time
  scope: () => McpScope; // settings.mcpExposure(), resolved live
  defsFor: (scope: Exclude<McpScope, "off">) => BridgeToolDef[]; // externalToolDefs closure (resolved fresh per MCP initialize)
}

// Owns the External MCP server (rookery-as-MCP): a SECOND McpBridge instance mounted at /mcp-ext on the
// daemon http server, gated by the mcpExposure setting. Mirrors SlackController's shape — a controller
// injected into Connection, wired only in startDaemon(). off is fail-closed (no session registered → the
// URL 404s). Scope/token changes take effect live via reconcile(); there is no separate process.
export class ExternalMcpController {
  private readonly bridge: McpBridge;
  private urlFn?: (host: string, port: number) => string;

  constructor(private readonly deps: ExternalMcpControllerDeps) {
    this.bridge = new McpBridge({ basePath: "/mcp-ext" });
  }

  // Wired into the daemon's http request listener (after the codex bridge). Returns true once the path
  // falls under /mcp-ext (including 404s for unknown/absent tokens), so the caller falls through only for
  // unrelated paths — same contract as the codex bridge's handleHttp.
  handleHttp(req: IncomingMessage, res: ServerResponse): boolean {
    return this.bridge.handleHttp(req, res);
  }

  // Idempotent: registers the external session with the current scope's tools (pinned to the persisted
  // token), or tears it down when off. Called at boot and whenever settings.set changes mcpExposure.
  // Switching scope/off drops live MCP sessions via ensureSession's transport-GC (release for off) — the
  // client then re-initializes and receives the new toolset (MCP has no "refresh tools" primitive).
  reconcile(): void {
    const scope = this.deps.scope();
    if (scope === "off") {
      this.bridge.release(EXTERNAL_MCP_KEY);
      this.urlFn = undefined;
      return;
    }
    const token = loadOrCreateToken(this.deps.tokenPath);
    const { url } = this.bridge.ensureSession(EXTERNAL_MCP_KEY, () => this.deps.defsFor(scope), { fixedToken: token });
    this.urlFn = url;
  }

  status(): ExternalMcpStatus {
    const scope = this.deps.scope();
    const url = scope === "off" || !this.urlFn ? null : this.urlFn(this.deps.host, this.deps.port());
    return { scope, url };
  }

  // Rotate the shared secret: writes a fresh token, drops any live session bound to the old token
  // (its URL immediately 404s), then re-registers under the new token. Returns the new status.
  regenerateToken(): ExternalMcpStatus {
    rotateToken(this.deps.tokenPath);
    this.bridge.release(EXTERNAL_MCP_KEY);
    this.urlFn = undefined;
    this.reconcile();
    return this.status();
  }
}
