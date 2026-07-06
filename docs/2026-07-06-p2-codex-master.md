# 2026-07-06 — P2: Codex master (spec)

> Status 2026-07-06: **implemented** — all 6 plan tasks + the T3b pricing-continuity fix landed on `feat/p2-codex-master` (bridge, `CodexBackend.startTurn`, tool-defs port, `AskUserQuestion` def, `sessions.provider` routing). Live smoke (bridge round-trip + resume with fresh `developerInstructions`) is pending — the controller runs it post-task, then routes to fable final review before merge.

Phase 2 of `docs/2026-07-05-codex-backend-parity.md`: **master sessions runnable on OpenAI Codex** — the orchestrator itself, with its memory/repos/fleet/schedule control plane, on `codex app-server`. Workers (P1) and the desktop UX (P1.5) are done; this closes the last provider gap except per-source overlays.

## De-risked by live spikes (2026-07-06, codex 0.142.5 — reference impls in `.superpowers/sdd/probe-mcp-*.mjs`)

1. **The MCP bridge works end-to-end**: a daemon-hosted **stateful** streamable-HTTP MCP server (per-`mcp-session-id` transports) was called by the codex model in-turn (`tools/call` → handler → result → model echoed it). Stateless per-request transports do NOT work with codex's rmcp client (turn path stalls); OAuth discovery probe paths must 404.
2. **Sandbox footgun (root cause of turn stalls)**: restricted sandboxes (read-only / workspace-write network policy) **silently block** turn-scoped MCP HTTP calls — `item/started` fires, `tools/call` never arrives, the turn hangs. `danger-full-access` works. ⇒ **P2 v1: codex masters run bypassPermissions only** (= the current de-facto master mode); other modes are rejected at turn start with a clear error.
3. **Per-session MCP config via spawn args**: `codex app-server -c mcp_servers.rookery.url="http://127.0.0.1:<port>/mcp/<token>"` — one child per session/turn means process-level `-c` IS per-session config. No dependence on undocumented per-thread config semantics.
4. **Tool definitions are reusable**: the Claude SDK's `tool()` returns `SdkMcpToolDefinition { name, description, inputSchema (zod raw shape), handler }` — the same objects register on an MCP-SDK `McpServer` (`registerTool`). `@modelcontextprotocol/sdk` 1.29.0 is already in node_modules (transitive) → becomes a **direct dependency**.
5. `thread/resume` accepts `developerInstructions` (schema) → **per-turn system-prompt injection problem is solved by the per-turn-child design** (see below).

## Architecture

### Master turn model on Codex: per-turn ephemeral child

`CodexBackend.startTurn(prompt, opts)` (P1 stub throws; P2 implements): spawn child (with `-c` MCP config + env) → handshake → `thread/start` (first turn) or `thread/resume {threadId, developerInstructions}` (later turns) → ONE `turn/start` → translate events (reuse P1 `translate`/notification handling via a shared session core) → `turn/completed` → kill child → stream ends.

Why per-turn child is the RIGHT shape here (not a compromise):
- `thread/resume` takes `developerInstructions` per call → **`buildSystemPrompt()` (memories + repo catalog, changes every turn) injects cleanly each turn** — the exact thing Codex lacks (`no per-turn append`) becomes free.
- Master turns are already serialized (`turnChain`) and the master never needs mid-turn input (`turn/steer`) — the streaming-input machinery is worker-only.
- Interrupt = `turn/interrupt` (graceful) with kill as backstop; rollouts persist, resume works — same recovery story as workers.
- Cost: one Rust-binary spawn + handshake per turn (~100-300ms) — acceptable; a persistent per-session child pool is a P2.5 optimization seam, not a v1 requirement.

`sessionId` = thread id, captured early (thread/started / start response) → `sessions.sdk_session_id` (existing column, provider-scoped semantics as with workers).

### The tool port: neutral tool defs through `MasterTurnOptions`

New port field (agent-backend.ts):
```ts
// Neutral in-process tool definition — structurally SdkMcpToolDefinition (name, description,
// zod raw shape, handler). Adapters wrap it for their provider.
export type ProviderToolDef = { name: string; description: string; inputSchema: Record<string, unknown>; handler: (args: never, extra: unknown) => Promise<unknown> };
export interface MasterTurnOptions extends AgentSessionOptions {
  ...existing...
  // Base in-process tool servers as RAW definitions (server name → defs). Claude adapter wraps them
  // with createSdkMcpServer; Codex adapter registers them on the daemon MCP bridge for the session.
  toolDefs?: Record<string, ProviderToolDef[]>;
}
```
- `src/tools/*-tools.ts` refactor: each file exports `*ToolDefs(deps): SdkMcpToolDefinition[]` (the existing `tool()` calls, extracted) and keeps `create*ToolsServer(deps) = createSdkMcpServer({ tools: *ToolDefs(deps) })` — Claude path byte-identical.
- `master-agent.ts` builds `toolDefs` (memory/repos/fleet + the capabilities overlay's schedule server stays as opaque `mcpServers` for Claude) — **v1: codex masters get the base three + schedule via defs**; per-source overlays (slack-thread) remain Claude-only (slack sessions default to claude anyway).
  - Concretely: `makeCapabilities` (server.ts) gains a defs-form for the schedule server so codex sessions receive schedule tools; slack-thread tools stay SDK-only.
- `ClaudeBackend.startTurn`: when `opts.toolDefs` present, wrap each group with `createSdkMcpServer` and merge into the SDK `mcpServers` option (existing opaque `mcpServers` still spread on top). `allowedTools` continues to gate exposure (names unchanged: `mcp__<server>__<name>`).
- `CodexBackend.startTurn`: registers/updates the session's defs on the **bridge** each turn (fresh closures), ignores the opaque `mcpServers`/`allowedTools`/`disallowedTools`/`canUseTool` fields except as noted below.

### The MCP bridge (`src/daemon/mcp-bridge.ts`)

- Mounted on the EXISTING daemon http server (`server.ts` `noServer`-mode http) at `POST/GET/DELETE /mcp/<session-token>` — no new port, loopback-only like everything else.
- **Stateful** streamable-HTTP per the spike: per-MCP-session transports keyed by `mcp-session-id`, created on `initialize`; GET (SSE) delegated to the transport; unknown paths 404. Reference: `probe-mcp-bridge4.mjs`.
- Registry: `registerSession(rookerySessionId, defsProvider: () => Record<string, ProviderToolDef[]>): { url, token }` — token = crypto-random per rookery session (URL-path auth; loopback + unguessable token, ws-token precedent); `releaseSession` on session close/delete. `defsProvider` is resolved per tools/list & tools/call so per-turn closures stay fresh.
- Tool names exposed FLAT as `<server>__<name>`? No — one bridge MCP server per rookery session exposing all defs; names must be unique across groups → prefix with the group: registered name = `<server>__<name>` is ugly for the model. Decision: register with the ORIGINAL tool name (spawn_worker, remember, …) — collisions impossible today (names are globally unique across our servers); guard with a dev-time assert.
- **AskUserQuestion**: when the session has a `canUseTool`-style interaction channel, the bridge tool set includes an `AskUserQuestion` def whose handler drives the SAME `InteractionRegistry.request` flow (desktop card / Slack) and returns the answers as tool output. Master-agent supplies it in `toolDefs` for codex sessions (claude keeps the native AskUserQuestion + canUseTool path unchanged).

### Provider plumbing

- Migration (append-only): `ALTER TABLE sessions ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude'`.
- `session.create` protocol message gains `provider: z.enum(["claude","codex"]).optional()`; `SessionManager.create/build` persists + routes: `MasterAgentDeps.backend` is chosen per session from the registry (claude default). Desktop new-session UI = P2.5 (protocol-first, same as P1 did for workers).
- Codex master model: `settings.codexWorkerModel()` shared default? Add `codexMasterModel` (default "gpt-5.5") for symmetry with master/worker split. Per-turn override (`TurnOverride.model`) flows as-is.
- Slack/automation sessions: claude-only in v1 (their creation paths don't pass provider).
- `maxTurns` master warning-only semantics carry over (numTurns = 1/turn on codex; warning threshold rarely hit — documented).
- Non-bypass permissionMode on a codex master: `startTurn` throws a clear error (spike finding #2) — surfaced as a turn failure notice.

## Non-goals (v1)

Per-source capability overlays for codex (slack-thread tools), codex masters for slack/automation origins, desktop new-session provider UI, persistent child pool, non-bypass permission modes, `plan` mode analog, bearer-header auth on the bridge (URL token suffices on loopback), nested-subagent panels.

## Testing

- Bridge: in-process http + MCP SDK client transport tests (initialize/list/call/session-isolation/404/auth-token mismatch/release). Plus a fake-transport CodexBackend.startTurn suite (thread/start vs resume w/ developerInstructions assertion, one-turn lifecycle, interrupt, non-bypass rejection, bridge registration calls).
- Tools refactor: existing tool tests keep passing (Claude path unchanged); a defs-level test asserting name uniqueness across groups.
- Master: MasterAgent with a codex fake backend — turn round-trip, notices, AskUserQuestion def presence when interaction channel exists.
- Live smoke (controller): codex master session e2e — runTurn that calls `remember` + `list_repos` through the bridge, then a second turn recalling (proves per-turn developerInstructions + bridge round-trip + resume).

## Risks

- rmcp streamable-HTTP client quirks (0.x): the bridge must stay tolerant (404 discovery, stateful-only); pin behavior with the live smoke.
- Silent-hang footgun if the bridge is down/unreachable mid-turn (codex-side, can't fix server-side): mitigate with a turn-level watchdog? v1: document; the master turn can be interrupted via stop.
- Bridge tool handler exceptions must map to MCP tool errors (isError content), never crash the http server.
