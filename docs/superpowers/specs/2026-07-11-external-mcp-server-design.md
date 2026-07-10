# External MCP Server (rookery-as-MCP) — Design

Date: 2026-07-11
Status: approved, ready for implementation
Branch: `feat/external-mcp-server`

## Goal

Expose rookery's fleet control plane to **external MCP clients** (Claude Code, Cursor, Codex CLI, any MCP host) so a user can drive the rookery worker fleet from inside another agent — e.g. `claude mcp add rookery --transport http http://127.0.0.1:8787/mcp-ext/<token>`. This is the first half of the "rookery-as-MCP" idea from the 2026-07-10 competitive analysis (the marketplace skill-pack distribution is a later follow-up).

Exposure is **off by default** (fail-closed, like the Slack allowlist) and controlled from Settings with three scope tiers.

## Non-goals (v1)

- Marketplace / skill-pack packaging (later).
- Memory (`remember`/`recall`) and repo mutation (`register_repo`/`remove_repo`) exposure — not exposed. Only fleet + `list_repos`.
- A separate long-lived server process. We mount on the existing daemon http server (user's explicit decision). Process isolation is deferred to a future team/remote-daemon story.
- Structured audit log — v1 logs one stderr line per external tool call; structured audit is a follow-up.
- Multi-client live broadcast of status — the Settings page fetches status on open and after save (request/response), no event push in v1.

## Why daemon-mounted (recap of the decision)

A separate always-on process would necessarily be a **proxy** back to the daemon (it can't reach `FleetOrchestrator` directly), buying a second lifecycle, a second auth surface, and version skew for no real isolation win in a single-user local tool. Mounting a second `McpBridge` instance on the daemon http server reuses the one **live-verified** stateful streamable-HTTP transport (codex 0.142.5) and keeps the daemon the single source of truth. The real boundary that matters is the **permission boundary** (what an external agent may do), not the process boundary — so v1 invests there (scope tiers) instead.

## Architecture

```
external MCP client (Claude Code / Cursor / Codex)
        │  streamable-HTTP  http://127.0.0.1:8787/mcp-ext/<token>
        ▼
daemon http server (server.ts)
  ├─ bridge      = new McpBridge({})            # /mcp    — codex master turns (existing)
  └─ extMcp      = new ExternalMcpController(...) # /mcp-ext — external clients (NEW)
        │  owns a second McpBridge({ basePath: "/mcp-ext" })
        ▼
  externalToolDefs({ fleet, repos, sessions }, scope)  # NEW  src/tools/external-tools.ts
        ▼
  FleetOrchestrator / Repositories / SessionManager   # unchanged core
```

The external tools spawn workers under a hidden home session `external:fleet` (mirrors `automation:fleet`), so those workers show up in the normal fleet views.

## Components

### 1. `ExternalMcpController` — `src/daemon/external-mcp-controller.ts` (NEW)

Single owner of the external exposure: the second bridge instance, the token file, reconcile, status, and token rotation. Mirrors `SlackController`'s shape (a controller injected into `Connection`, wired only in `startDaemon()`).

```ts
const EXTERNAL_MCP_KEY = "external"; // bridge sessionKey (namespace-isolated from codex session ids)
type McpScope = "off" | "readonly" | "full";

class ExternalMcpController {
  private readonly bridge = new McpBridge({ basePath: "/mcp-ext" });
  private urlFn?: (host: string, port: number) => string;
  constructor(private deps: {
    tokenPath: string;                       // ~/.rookery/mcp-token
    host: string;                            // config.host
    port: () => number;                      // reads boundPort (ephemeral-safe)
    scope: () => McpScope;                   // from settings.mcpExposure()
    defsFor: (scope: Exclude<McpScope,"off">) => BridgeToolDef[]; // externalToolDefs closure
    emit?: (s: { scope: McpScope; url: string | null }) => void;  // optional broadcast (unused v1)
  }) {}

  handleHttp(req, res): boolean { return this.bridge.handleHttp(req, res); }

  reconcile(): void {
    const scope = this.deps.scope();
    if (scope === "off") { this.bridge.release(EXTERNAL_MCP_KEY); this.urlFn = undefined; return; }
    const token = loadOrCreateToken(this.deps.tokenPath);
    const { url } = this.bridge.ensureSession(EXTERNAL_MCP_KEY, () => this.deps.defsFor(scope), { fixedToken: token });
    this.urlFn = url;
  }

  status(): { scope: McpScope; url: string | null } {
    const scope = this.deps.scope();
    const url = scope === "off" || !this.urlFn ? null : this.urlFn(this.deps.host, this.deps.port());
    return { scope, url };
  }

  regenerateToken(): { scope: McpScope; url: string | null } {
    rotateToken(this.deps.tokenPath);       // unconditionally writes a fresh token
    this.bridge.release(EXTERNAL_MCP_KEY);  // drop live sessions bound to the old token
    this.reconcile();
    return this.status();
  }
}
```

Notes:
- `reconcile()` is called at boot and whenever `settings.set` includes `mcpExposure`. Changing the scope live triggers `ensureSession`'s existing transport-GC, which drops live MCP sessions → the client re-`initialize`s and gets the new toolset (there is no MCP "refresh tools" primitive; this is the correct semantics).
- The `defsFor` closure resolves **fresh per MCP-session `initialize`** (bridge behavior), so scope changes take effect without restart.

### 2. `McpBridge.ensureSession` — add `fixedToken` (small change to `src/daemon/mcp-bridge.ts`)

Add an optional third arg `opts?: { fixedToken?: string }`. Only affects **new** session creation: `const token = opts?.fixedToken ?? randomUUID();`. Existing entries keep their stable token (unchanged behavior — codex path passes no opts). Token rotation for the external server is done by `release()` + `ensureSession(..., { fixedToken })`, never by mutating an existing entry.

### 3. `externalToolDefs` — `src/tools/external-tools.ts` (NEW)

`externalToolDefs(deps: { fleet, repos, sessions }, scope: "readonly" | "full"): SdkMcpToolDefinition<any>[]`

Reuses `spawnWorkerImpl` and `formatTranscript` from `fleet-tools.ts` (exported already). Tool descriptions are rewritten for the external caller's point of view (no "your turn will be woken" master-centric phrasing).

| scope | tools |
|---|---|
| `readonly` | `list_workers`, `get_worker_status`, `view_worker_transcript`, `view_worker_diff`, `list_repos` |
| `full` | readonly + `spawn_worker`, `send_worker`, `interrupt_worker`, `stop_worker`, `discard_worker` |

- `notify` is **omitted** from the external `spawn_worker`/`send_worker` schemas — the notifier wakes the home master session, which for `external:fleet` has no live client; external clients poll `get_worker_status`/`list_workers` instead. (Harmless if it leaked, but the field is meaningless externally, so it's dropped.)
- `spawn_worker` resolves its home session lazily per call: `const home = sessions.getOrCreateByKey(EXTERNAL_FLEET_SESSION_KEY, repo.path)` → `spawnWorkerImpl(fleet, repos, home.id, args)`. Same pattern as `automation-action.ts`.
- `workerCostBudgetUsd` settings default applies automatically through `fleet.spawn` (inherited guard, no extra wiring).
- Each handler logs one stderr line: `console.error("[mcp-ext] tool=<name>")` (v1 audit; no args to avoid leaking task text volume).

### 4. `EXTERNAL_FLEET_SESSION_KEY` — `src/core/session-manager.ts`

Add `export const EXTERNAL_FLEET_SESSION_KEY = "external:fleet";` next to `UI_FLEET_SESSION_KEY`/`AUTOMATION_FLEET_SESSION_KEY`, and add it to the `list()` hide-filter (line ~268) so the container session doesn't clutter the session list (its workers still show in the fleet).

### 5. Settings — `src/core/settings.ts`

Add `mcpExposure: string` to `SettingsValues` (echoed — not a secret). Getter coerces fail-closed:

```ts
mcpExposure(): "off" | "readonly" | "full" {
  const v = this.repos.getSetting("mcpExposure");
  return v === "readonly" || v === "full" ? v : "off"; // unknown/missing → off (fail-closed)
}
```

`all()` echoes `mcpExposure: this.mcpExposure()`. `settings.set` schema (messages.ts) gets `mcpExposure: z.string().nullable().optional()`.

### 6. Config + fs-hardening

- `src/config.ts`: add `mcpTokenPath: path.join(home, "mcp-token")` to `Config`.
- `src/daemon/fs-hardening.ts`: add `config.mcpTokenPath` to `secureFilePaths()` and `SecureConfig`'s `Pick`.
- `src/daemon/auth.ts`: add `rotateToken(tokenPath)` — writes a fresh `randomBytes(24).base64url` at 0600 unconditionally (regeneration). `loadOrCreateToken` is reused as-is for the read/create path.

### 7. Protocol — `src/protocol/messages.ts`

Two new request messages + one result:
- `{ type: "mcp.status", reqId }` → `mcp.status.result`
- `{ type: "mcp.regenerate_token", reqId }` → `mcp.status.result`
- Result: `{ type: "mcp.status.result", reqId, scope: "off"|"readonly"|"full", url: string | null }`
- `RequestResultMap`: both map to `mcp.status.result`.

`mcpExposure` itself rides the existing `settings.get`/`settings.set`.

### 8. Connection — `src/daemon/connection.ts`

- Inject `externalMcp?: ExternalMcpController` (like `slack`).
- `settings.set` handler: after `apply(rest)`, if `"mcpExposure" in rest` → `this.externalMcp?.reconcile()` (mirrors the `slackTokenChanged → slack.reconcile()` line).
- New cases: `mcp.status` → reply `externalMcp.status()`; `mcp.regenerate_token` → reply `externalMcp.regenerateToken()`. If `externalMcp` is absent, reply an `error` (mirrors `settings unavailable`).

### 9. server.ts wiring (composition root)

```ts
const extMcp = new ExternalMcpController({
  tokenPath: config.mcpTokenPath, host: config.host, port: () => boundPort,
  scope: () => settings.mcpExposure(),
  defsFor: (scope) => externalToolDefs({ fleet, repos, sessions }, scope) as unknown as BridgeToolDef[],
});
extMcp.reconcile(); // boot
// in the http listener, after the codex bridge:
if (extMcp.handleHttp(req, res)) return;
// inject into Connection alongside slack
```

(`sessions` is constructed before this point already; `externalToolDefs` casts to `BridgeToolDef[]` exactly like the codex path casts `fleetToolDefs`.)

### 10. Desktop — Settings UI

`apps/desktop`: new "External MCP" section on the Settings page:
- Scope selector: Off / Read-only / Full (bound to `mcpExposure`).
- When not Off: show the URL (from `mcp.status`) with a copy button, and a "Regenerate token" button (`mcp.regenerate_token`).
- Full shows a warning: an external agent can drive the bypassPermissions fleet.
- Client wrapper methods `mcpStatus()` / `mcpRegenerateToken()`; fetch status on section mount and after a settings save that touched `mcpExposure`.
- i18n strings in the renderer catalog (ko/en).
- **Gate: `npm -w apps/desktop run typecheck && npm -w apps/desktop test`** (SettingsValues change — CLAUDE.md pitfall).

## Edge cases

- Off → any `/mcp-ext/*` request 404s (bridge unknown-token path; no "used to exist" oracle).
- Regenerate / switch to Off → live external MCP sessions drop immediately (documented in the UI warning).
- Unknown stored `mcpExposure` value → treated as Off (fail-closed).
- The codex `/mcp` bridge and `/mcp-ext` are fully token/session namespace-isolated — no cross-talk.
- Non-local `ROOKERY_HOST` bind: the mcp-token, like ws-token, then rides plaintext — extend the existing stderr plaintext warning to mention it.

## Testing

- `test/daemon/mcp-bridge.test.ts`: `fixedToken` keeps a stable URL on new-session creation; codex path (no opts) unchanged.
- `test/daemon/external-mcp-controller.test.ts`: off→`status.url===null` and `/mcp-ext` 404; readonly/full→url present; regenerate rotates the token (old token 404s, new url differs); scope resolved live from the injected `scope()`.
- `test/tools/external-tools.test.ts`: scope→toolset mapping (readonly has 5 tools, none of the mutating ones; full has 10); `notify` absent from spawn/send schemas; `spawn_worker` routes through `getOrCreateByKey(EXTERNAL_FLEET_SESSION_KEY, …)` (fake sessions/fleet).
- `test/core/settings.test.ts`: `mcpExposure` fail-closed coercion + echoed in `all()`.
- Connection: `settings.set { mcpExposure }` calls `externalMcp.reconcile()`; `mcp.status`/`mcp.regenerate_token` replies.
- Token file created 0600.

## Rollout / docs

- Update `CLAUDE.md` env/settings notes: new `mcpExposure` setting + `~/.rookery/mcp-token` in the home-layout list.
- README: a short "Expose rookery to other agents (External MCP)" subsection with the `claude mcp add` one-liner.
