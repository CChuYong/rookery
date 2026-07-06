# P2 Codex Master Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Master sessions runnable on Codex: a daemon-hosted streamable-HTTP MCP bridge carries the master's control plane (memory/repos/fleet/schedule + AskUserQuestion), `CodexBackend.startTurn` runs per-turn ephemeral children with per-turn `developerInstructions` injection, and sessions gain a `provider`. Spec: `docs/2026-07-06-p2-codex-master.md` (read it first — it encodes live-spike findings that are load-bearing).

**Architecture:** see spec. Verified reference implementation for the bridge's transport handling: `.superpowers/sdd/probe-mcp-bridge4.mjs` (stateful pattern that codex's rmcp client actually works with — stateless DOES NOT work, this was measured).

**Tech Stack:** adds `@modelcontextprotocol/sdk` (already in node_modules transitively at 1.29.0) as a DIRECT dependency. No other new deps.

## Global Constraints

- **Node 22 first** for every command: `source ~/.nvm/nvm.sh && nvm use 22`.
- ESM NodeNext (`.js` relative imports, `import type`); English comments.
- **Migrations append-only** (one new entry at END of MIGRATIONS).
- Neutrality gate: `src/core/codex/*` stays free of `@anthropic-ai/claude-agent-sdk` imports. The new port type `ProviderToolDef` must be STRUCTURAL (no SDK import in `agent-backend.ts`) — the SDK's `SdkMcpToolDefinition` is assignable to it, which a compile-time test pins.
- **Dual gates** on every task touching shared types or renderer-visible protocol: root `npm run typecheck && npm test` AND `npm -w apps/desktop run typecheck && npm -w apps/desktop test`.
- **Claude-path byte-parity**: existing master behavior on Claude must not change — the capture tests in `test/core/master-agent.test.ts`/`master-capabilities.test.ts` are the guard; any assertion change needs controller sign-off (report DONE_WITH_CONCERNS).
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

### Task 1: MCP bridge core (`src/daemon/mcp-bridge.ts`, TDD)

**Files:** Create `src/daemon/mcp-bridge.ts`, `test/daemon/mcp-bridge.test.ts`. Modify `package.json` (add `@modelcontextprotocol/sdk` to dependencies at the version currently resolved in node_modules — check `npm ls @modelcontextprotocol/sdk`; run `npm install` so the lockfile records it as direct).

**Interfaces (produces):**
```ts
export interface BridgeToolDef { name: string; description: string; inputSchema: Record<string, unknown>; handler: (args: never, extra: unknown) => Promise<unknown> }
export class McpBridge {
  constructor(opts: { basePath?: string }) // default "/mcp"
  ensureSession(sessionKey: string, defsProvider: () => BridgeToolDef[]): { url: (host: string, port: number) => string; token: string } // stable token per key; defsProvider re-resolved per MCP request
  release(sessionKey: string): void  // closes live transports for that session
  // http hook wired in server.ts: returns true if the request was handled (path matched basePath)
  handleHttp(req: IncomingMessage, res: ServerResponse): boolean
}
```
Behavior (mirror `probe-mcp-bridge4.mjs`, hardened):
- Path `/<basePath>/<token>`: token → sessionKey lookup; unknown token → 404 (no oracle). Non-bridge paths → return false (server.ts falls through to its existing routing). OAuth discovery probes under the base path → 404.
- Stateful streamable HTTP: on `initialize` POST create a `StreamableHTTPServerTransport` (`sessionIdGenerator: randomUUID`, `onsessioninitialized` → store keyed by mcp-session-id under that sessionKey), connect a fresh `McpServer` whose tools come from `defsProvider()` resolved AT CONNECT; `tools/list`/`tools/call` re-register per-connect (per-turn closures stay fresh because CodexBackend calls `ensureSession` with a new provider each turn — see Task 3; a single MCP session spans one child lifetime = one turn, so connect-time resolution is per-turn fresh). GET/DELETE with a known mcp-session-id → delegate to the transport. Requests without session + not initialize → 400.
- Tool registration: `McpServer.registerTool(def.name, { description, inputSchema }, wrapped-handler)`; handler exceptions → `{ content: [{type:"text", text: "tool error: ..."}], isError: true }`, NEVER thrown (http 200; the model sees the error).
- `release`: close+delete all transports for the sessionKey and forget the token.

**Tests** (drive with `@modelcontextprotocol/sdk/client` + `StreamableHTTPClientTransport` against an in-process `http.createServer((req,res)=>{ if (!bridge.handleHttp(req,res)) { res.statusCode=404; res.end(); } })`): initialize+list+call round-trip; per-session isolation (two sessions, different defs, token A cannot see B's tools); unknown token 404; handler-throw → isError result; release → subsequent requests 404; defsProvider re-resolution (mutate the def list between two initializes → second connect sees new tools).

Gates: root only (no shared-type change). Commit: `feat(daemon): streamable-HTTP MCP bridge (stateful, per-session token routing)`.

---

### Task 2: Neutral tool defs through the port (TDD, Claude byte-parity)

**Files:** Modify `src/core/agent-backend.ts` (add `ProviderToolDef` + `MasterTurnOptions.toolDefs?: Record<string, ProviderToolDef[]>` + `MasterTurnOptions.sessionKey?: string`), all 5 `src/tools/*-tools.ts` + `src/tools/schedule-tools.ts` pattern (export `*ToolDefs(deps): SdkMcpToolDefinition[]`; `create*ToolsServer` becomes `createSdkMcpServer({ name, tools: *ToolDefs(deps) })` — read each file first, keep `*_TOOL_NAMES` untouched), `src/core/claude-backend.ts` (wrap `opts.toolDefs` groups with `createSdkMcpServer` and merge under the SDK `mcpServers` option — opaque `opts.mcpServers` spreads AFTER so per-source overlays still win on key collision), `src/core/master-agent.ts` (build `toolDefs: { memory: memoryToolDefs(repos), repos: repoToolDefs(repos), fleet: fleetToolDefs(fleet, repos, sessionId) }` and pass `sessionKey: sessionId`; STOP passing the three base servers through the old inline `mcpServers` object — they now travel as defs; the capabilities overlay (`caps.mcpServers`, schedule etc.) keeps flowing opaque).

**Byte-parity requirement:** after this task, the SDK `query()` call for a Claude master turn must receive an `mcpServers` record with the SAME keys and functionally identical server instances as before. The existing capture tests assert key presence — they must pass UNMODIFIED. `allowedTools` assembly unchanged.

**Tests:** name-uniqueness across all def groups (flat set, no duplicates — dev guard for the bridge's flat namespace); a compile-time assignability pin `const _check: ProviderToolDef[] = memoryToolDefs(reposStub)` in a root test; existing master/tools tests green unmodified.

Gates: dual (agent-backend.ts is renderer-imported via @daemon type mirrors — prove nothing broke). Commit: `refactor(tools): export raw tool defs; toolDefs travel the port (claude byte-parity)`.

---

### Task 3: `CodexBackend.startTurn` — per-turn ephemeral child (TDD)

**Files:** Modify `src/core/codex/codex-backend.ts`, `src/core/codex/codex-transport.ts` (`CodexSpawn` opts gain `args?: string[]`; `realCodexSpawn` appends them to `["app-server"]`), `test/helpers/fake-codex.ts` (record spawn args; support the single-turn flow), `test/core/codex/codex-backend.test.ts`.

**Design (from spec — the implementer extracts a shared core rather than duplicating):** refactor `CodexStream`'s client/notification/translation machinery into a shared internal core (client setup, `handleNotification`, `handleServerRequest`, EventChannel, pricing accumulator, session_id emission) parameterized by the input strategy. `openSession` keeps the input-pump strategy (existing tests green unmodified — parity bar). New `startTurn(prompt, opts)`:
1. Reject non-bypass modes: `if (mapPermissionMode(opts.permissionMode).sandbox !== "danger-full-access") throw new Error("codex master sessions require bypassPermissions (restricted sandboxes silently block the MCP bridge — see docs/2026-07-06-p2-codex-master.md)")` — thrown SYNCHRONOUSLY like the P1 stub.
2. Bridge wiring: `CodexBackendDeps` gains `bridge?: { ensureSession(key: string, defs: () => BridgeToolDef[]): { url: string }; }` (note: server.ts pre-binds host/port so the backend sees a plain url string) — when `opts.sessionKey && opts.toolDefs && deps.bridge`, call `ensureSession(sessionKey, () => flattenedDefs)` and spawn the child with `args: ["-c", `mcp_servers.rookery.url="${url}"`]`.
3. Thread lifecycle: `opts.resume` → `thread/resume { threadId, cwd, approvalPolicy, sandbox, model, developerInstructions: opts.systemPromptAppend }`; fresh → `thread/start { ..., developerInstructions: opts.systemPromptAppend }`. Early `session_id` emission both paths (port contract).
4. ONE `turn/start` (input = prompt text; per-turn model/effort/sandboxPolicy exactly like the worker path), await turn/completed, then close child, end stream. `interrupt()` = turn/interrupt with the active turn id (kill via close as backstop). Pricing/turn_end telemetry identical to workers (shared core).

**Tests:** happy turn (fresh: thread/start carries developerInstructions + spawn args carry the bridge url; events translate; turn_end priced); resume turn (thread/resume + updated developerInstructions string asserted); non-bypass throws synchronously with the documented message; interrupt mid-turn → subtype interrupted + child killed; bridge ensureSession called once per turn with fresh defs; no bridge deps → no `-c` args (tool-less codex master still works); existing openSession suite green UNMODIFIED.

Gates: root. Commit: `feat(codex): startTurn — per-turn ephemeral child with developerInstructions + bridge wiring`.

---

### Task 4: AskUserQuestion over the bridge (TDD)

**Files:** Modify `src/core/master-agent.ts` (when `deps.canUseTool` exists AND the session's backend is codex — decision: master-agent stays provider-agnostic; instead ALWAYS include an `AskUserQuestion` def in `toolDefs` when `deps.canUseTool` exists, built by a new module), Create `src/tools/ask-user-question-def.ts` + test. Modify `src/core/claude-backend.ts`: strip the `AskUserQuestion` def group before wrapping (Claude uses the NATIVE AskUserQuestion tool + canUseTool — a duplicate MCP tool would confuse the model; the def travels the port but the Claude adapter drops it).

**Contract (read `src/core/interaction-registry.ts` + how `canUseTool` answers AskUserQuestion via `PermissionResult.updatedInput` before writing this):** the def's handler receives `{ questions: [...] }` (mirror the native tool's input shape — copy the zod shape from how interaction-registry/slack parse it), invokes the injected canUseTool-style channel (`deps.canUseTool` cast to its real signature by the caller that builds the def — master-agent passes a thin `ask(questions) => Promise<answers>` closure it derives from `canUseTool("AskUserQuestion", input, {})`), and returns the answers as `{ content: [{ type: "text", text: JSON.stringify(answers) }] }`. Denial/no-answer → isError text result.

**Tests:** def handler round-trip against a stubbed ask channel (answers serialized; denial → isError); master-agent includes the def group only when canUseTool exists (capture toolDefs); ClaudeBackend drops the group (capture: SDK mcpServers has no askUserQuestion key) while CodexBackend passes it to the bridge (fake bridge records defs incl. AskUserQuestion).

Gates: root. Commit: `feat(master): AskUserQuestion as a bridge tool def for codex masters (claude path native, unchanged)`.

---

### Task 5: Provider plumbing — sessions.provider, protocol, SessionManager, server wiring (TDD)

**Files:** `src/persistence/db.ts` (append `ALTER TABLE sessions ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude'`), `src/persistence/repositories.ts` (createSession accepts provider; row exposes it), `src/protocol/messages.ts` (`session.create` gains `provider: z.enum(["claude","codex"]).optional()`; the session list row type gains `provider?: string`), `src/daemon/connection.ts` (thread provider through session.create; session list passthrough), `src/core/session-manager.ts` (deps gain `backends: Record<string, AgentBackend>` replacing the single `backend` — DEFAULT key "claude"; `build()` picks by the row's provider; `create()` persists it), `src/core/settings.ts` (`codexMasterModel()` default "gpt-5.5"), `src/daemon/server.ts` (construct `McpBridge`, mount in the http request handler BEFORE existing routes: `if (bridge.handleHttp(req,res)) return;`; pass `bridge` + a bound-url closure into `CodexBackend` deps; SessionManager gets `backends: { claude: backend, codex: codexBackend }`; master model resolver: codex sessions use `settings.codexMasterModel()` — thread through SessionManager's model resolver by provider; `sessions.delete` path calls `bridge.release(id)`).

Model resolver nuance (read session-manager/master-agent first): `masterModel` is a global resolver today. Provider-aware: SessionManager.build picks `model: provider === "codex" ? () => settings.codexMasterModel() : masterModelResolver` — plumb as a per-provider resolver map from server.ts, following the existing resolver conventions.

**Tests:** migration + createSession provider round-trip (default claude); session.create protocol with provider codex → SessionManager received it (connection test); SessionManager.build routes to the right backend (fake backends record startTurn calls); fork of a codex session → still claude-only master fork? — `SessionManager.fork` uses the SDK ForkFn: for codex sessions v1, fork must route like workers: reuse the fleet pattern — change `SessionManagerDeps.forkSession` to `(provider, sdkSessionId, opts)` with server routing codex → `codexBackend.forkSession` (same as fleet). Update its call site + tests. Desktop untouched (optional protocol fields) — dual gates prove it.

Gates: DUAL. Commit: `feat(daemon): session provider routing + MCP bridge mount + codexMasterModel`.

---

### Task 6: Docs + gates + handoff

**Files:** `AGENTS.md` (master section: masters can run on codex — bypassPermissions only (bridge/sandbox footgun), per-turn child + developerInstructions, tools via the daemon MCP bridge at `/mcp/<token>`; Tools section: base servers now defined as raw defs shared by both providers), `docs/2026-07-05-codex-backend-parity.md` (status: P2 implemented; remaining: per-source overlays, slack/automation codex origins, desktop session-provider UI, persistent child pool — P2.5), spec status blockquote.
Full gates: root typecheck/test/build + desktop typecheck/test. Commit: `docs(codex): P2 status + master-on-codex pitfalls`.

## Post-plan (controller)

Live smoke: codex master session — session.create provider codex → runTurn "remember the fact X then list repos" (bridge round-trip) → second turn "recall X" (proves resume + fresh developerInstructions with the new memory injected). Then fable final review → merge decision.

## Self-Review Notes

- Byte-parity guard for Claude masters is the plan's backbone (Task 2) — capture tests unmodified is the acceptance bar.
- The bridge's per-connect defs resolution + per-turn child = per-turn tool freshness without an update API.
- Task 4's Claude-drops-the-def rule prevents double AskUserQuestion exposure.
- Deliberately deferred: overlays for codex, slack/automation origins, session-provider UI, child pool (all documented in spec Non-goals).
