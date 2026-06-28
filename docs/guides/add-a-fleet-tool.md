# Add a Fleet Tool (master MCP tool)

> **Source of truth:** `src/tools/fleet-tools.ts`, `src/tools/memory-tools.ts`, `src/tools/repo-tools.ts`, `src/core/master-agent.ts` — the code is authoritative; this doc explains concepts and flows. The always-loaded map/conventions live in [AGENTS.md](../../AGENTS.md); this goes deeper.

The master agent's tools are in-process MCP servers built with `createSdkMcpServer()` + `tool()` from `@anthropic-ai/claude-agent-sdk`. There are three servers — `memory`, `repos`, `fleet` (`src/tools/*.ts`). **Workers do not get any of these** (they run the default `claude_code` toolset with `cwd: worktree`); only the master receives them. Adding a tool = adding a `tool()` to the right server and keeping its allowlist in sync.

## The allowlist invariant (read first)

The master runs with `permissionMode: "bypassPermissions"`, so the **only** gate on what the model can call is the `allowedTools` allowlist. Each tool file exports a `*_TOOL_NAMES` constant (e.g. `FLEET_TOOL_NAMES` in `src/tools/fleet-tools.ts:13`) listing every tool's fully-qualified name `mcp__<server>__<name>`. `MasterAgent` concatenates these into `baseAllowed` (`src/core/master-agent.ts:224`):

```ts
const baseAllowed = [...MEMORY_TOOL_NAMES, ...REPO_TOOL_NAMES, ...FLEET_TOOL_NAMES, ...];
```

If you add a `tool("foo", …)` to the fleet server but forget `"mcp__fleet__foo"` in `FLEET_TOOL_NAMES`, the tool **registers but is silently unusable** — the model never sees it in `allowedTools`. The name format is `mcp__<serverName>__<toolName>`; the server name comes from `FLEET_SERVER_NAME` (`"fleet"`, passed to `createSdkMcpServer({ name })`).

## Recipe: add a tool to the fleet server

Mirror an existing read-only tool like `get_worker_status` (`src/tools/fleet-tools.ts:93`).

1. **Add the `tool()` inside `createFleetToolsServer`** (`src/tools/fleet-tools.ts:31`). Signature: `tool(name, description, zodShape, handler, options?)`.
   - `name` — bare name, no `mcp__` prefix (e.g. `"pause_worker"`).
   - `description` — what the master sees; be precise, the model selects tools by this.
   - input schema — a plain object of `zod` fields (`{ id: z.string() }`), each `.describe(...)`'d where non-obvious.
   - handler — `async (args) => …` returning `text(...)` on success or `errorText(...)` on failure (helpers at `src/tools/fleet-tools.ts:24-29`; `errorText` sets `isError: true`). Always wrap fallible work in `try/catch` and return `errorText(String(err))` — never throw.
   - `options` — pass `{ annotations: { readOnlyHint: true } }` for tools that don't mutate (see `list`/`status`/`transcript`/`diff`).
2. **Register it in the `tools: [...]` array** of `createSdkMcpServer` at the bottom (`src/tools/fleet-tools.ts:168`).
3. **Add its qualified name to `FLEET_TOOL_NAMES`** (`src/tools/fleet-tools.ts:13`): `"mcp__fleet__pause_worker"`. Keep it `as const`.
4. **Use injected dependencies only.** The factory receives `fleet: FleetOrchestrator`, `repos: Repositories`, `homeSessionId: string`. Drive lifecycle through `fleet.*` (e.g. `fleet.spawn`, `fleet.send`, `fleet.stop`), never shell out or touch git directly — `GitOps` is the fleet's port. Resolve repos by name via `repos.getRepoByName(args.repo)` and reject unknowns with `errorText`.

That's it — the three tool servers are constructed inline in `MasterAgent.doTurn` (`src/core/master-agent.ts:263`), re-created every turn, so a new tool is live immediately with no `server.ts` change. (`server.ts` only wires the *separate* `schedule` tool server; see below.)

## Adding a whole new tool server (rare)

If you need a new server (not a tool on an existing one), mirror `schedule-tools.ts`, which is the one tool server wired in the composition root rather than inside `MasterAgent`:

1. Create `src/tools/<name>-tools.ts` exporting `createXToolsServer(...)`, `X_SERVER_NAME`, and `X_TOOL_NAMES`.
2. Wire it in `startDaemon()` only — `src/daemon/server.ts:138-139` shows the pattern: merge into `mcpServers` and append `X_TOOL_NAMES` to `allowedTools` via the per-session `capabilities()` overlay. The core never imports the composition root; new deps are passed in as interfaces.

For memory/repos/fleet, prefer adding to the existing server in `MasterAgent` rather than introducing a new one.

## Gotchas

- **Allowlist drift = silent failure.** The `*_TOOL_NAMES` entry and the `tool()` name must match exactly. There is no runtime check; nothing logs.
- **Workers never receive these tools** — they can't spawn fleet, recall memory, or register repos. Don't assume a worker can call a master tool.
- **bypassPermissions multiplies blast radius.** A fleet tool that mutates worktrees/repos runs unattended with no cost/turn budget guard. Keep destructive tools explicit and well-described (`discard_worker` says it discards uncommitted work).
- ESM NodeNext: relative imports need the `.js` extension; use `import type` for type-only imports (`McpSdkServerConfigWithInstance`, `FleetOrchestrator`, `Repositories`).

## Test & gate

Tool impls that contain real logic are unit-testable by extracting the body into an exported `*Impl(repos, args)` function and testing it directly — see `rememberImpl`/`recallImpl` (`src/tools/memory-tools.ts:9-23`) and their tests under `test/tools/`. The `tool()` wrapper itself is a thin adapter; test the impl, not the SDK plumbing.

Run the gate before committing:

```bash
npm run typecheck   # tsx/vitest do NOT typecheck — this is the real gate
npm test
```

Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

See also: [add-a-protocol-message.md](add-a-protocol-message.md) (if the desktop needs to invoke the capability directly, not via the model), [../architecture/fleet-lifecycle.md](../architecture/fleet-lifecycle.md).
