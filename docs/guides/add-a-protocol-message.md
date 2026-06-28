# Add a Protocol Message (WS client/server)

> **Source of truth:** `src/protocol/messages.ts`, `src/daemon/connection.ts`, `apps/desktop/src/renderer/ws/client.ts` — the code is authoritative; this doc explains concepts and flows. The always-loaded map/conventions live in [AGENTS.md](../../AGENTS.md); this goes deeper.

The daemon and its thin clients (CLI, desktop, Slack) talk over a single WebSocket. **Inbound** (client→daemon) messages are validated with the zod `clientMessageSchema` discriminated union; **outbound** (daemon→client) `ServerMessage` is a plain TypeScript union that is only `JSON.stringify`'d (no schema validation). `reqId` correlates a request with its response; fire-and-forget messages omit it. Full catalog: [../reference/protocol.md](../reference/protocol.md).

## Two shapes of message

- **Request/response** — client sends with a `reqId`, daemon replies with one matching ServerMessage. Type-safe end to end via `RequestResultMap` (`src/protocol/messages.ts:188`).
- **Fire-and-forget** — no `reqId`, no reply (e.g. `session.send`, `session.attach`, `*.subscribe`, `worker.send`). Excluded from `RequestResultMap`.

Pick the shape first; it determines which pieces you touch.

## Recipe: add a request/response message

Mirror an existing simple request like `models.list` → `models.result` (`src/protocol/messages.ts:94`, `src/daemon/connection.ts:391`).

1. **Inbound variant** — add a member to `clientMessageSchema` (`src/protocol/messages.ts:40`). It's a `discriminatedUnion("type", …)`, so every member is `z.object({ type: z.literal("<name>"), …, reqId: z.string() })`. For request/response make `reqId` required (`z.string()`); for fire-and-forget make it `.optional()` or omit. Validate/constrain fields here (this is the trust boundary — e.g. enums, `effortField`, the `automationInputSchema.superRefine` cron check at line 34).
2. **Outbound result type** — add a member to the `ServerMessage` union (`src/protocol/messages.ts:156`): `{ type: "<name>.result"; reqId: string; … }`. This is a hand-written TS union, not zod.
3. **Map them** — add a line to `RequestResultMap` (`src/protocol/messages.ts:188`): `"<name>": Extract<ServerMessage, { type: "<name>.result" }>;`. This keeps `WsClient.request()` type-safe (input type ↔ result type) and **must stay 1:1** with the daemon's reply.
4. **Handler** — add a `case "<name>":` to the switch in `Connection.handleRaw` (`src/daemon/connection.ts:125`). Do the work via injected services (`this.sessions`, `this.fleet`, `this.repos`, `this.automations`, etc.) and call `this.reply({ type: "<name>.result", reqId: msg.reqId, … })`. Each case `return`s. Throwing is safe — the outer `try/catch` (`src/daemon/connection.ts:489`) replies with `{ type: "error", reqId }` so the client's pending `request()` rejects instead of hanging. Mutations without their own result type reply with the generic `fleet.ack` (see `session.rename` at line 170).
5. **Mutations broadcast** — if the change is visible to other clients, emit a CoreEvent on the right `EventBus` channel after replying (e.g. automation handlers emit `automation.changed` on `ALL_CHANNEL`, `src/daemon/connection.ts:454`). See [../reference/events.md](../reference/events.md).

## Client side (desktop) — high level

`apps/desktop/src/renderer/ws/client.ts` is the renderer's `WsClient`. It injects the `reqId` (`q0`, `q1`, …) and correlates the reply, so callers use `request({ type: "<name>", … })` **without** a `reqId` (the `RequestInput<K>` helper omits it). Because `RequestResultMap` is imported via the `@daemon/*` type-only alias, the call is fully typed — adding your map entry is what makes the new `request()` compile. Server-pushed events (`{ type: "event", event }`) flow through `onEvent` → the store reducer; no per-message wiring needed for events. (CLI is similar but minimal.)

## Gotchas

- **Discriminated union** — the `type` literal must be unique across `clientMessageSchema`. zod rejects duplicate discriminators.
- **Inbound is validated, outbound is not.** Malformed inbound → `{ type: "error" }` reply (`src/daemon/connection.ts:118`). Outbound is trusted; a wrong-shaped ServerMessage just ships as-is and breaks the client silently — keep the union and `RequestResultMap` honest.
- **Keep `RequestResultMap` 1:1 with `connection.ts`.** It's the single source the desktop relies on; drift means the client expects a result type the daemon never sends.
- **`reqId` discipline** — request/response needs it on both ends; fire-and-forget must not expect a reply. Don't reply to a fire-and-forget message.
- ESM NodeNext: `.js` import extensions, `import type` for types.

## Test & gate

`src/protocol/messages.ts` exports `parseClientMessage(raw)` (zod parse) and `serializeServerMessage(msg)`. Test new validation rules against `parseClientMessage` directly (mirror under `test/protocol/`). Handler behavior is testable by constructing a `Connection` with fake services and feeding raw JSON to `handleRaw`. Then:

```bash
npm run typecheck
npm test
npm -w apps/desktop run typecheck   # the desktop imports RequestResultMap via @daemon/* — catch drift here
```

Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
