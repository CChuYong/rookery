# Capability Scope Defaults and Previews Design

Status: implemented on 2026-07-16

## Goal

Let users configure Rookery-wide default capabilities and inspect the capabilities a
future UI-started master or worker would receive before creating a session or worktree.
Capability Center must support Rookery, registered-repository, live-master, and
live-worker targets from one Effective target selector without weakening the existing
authority, trust, runtime-state, or secret boundaries.

Slice 9 builds on Slice 8's Catalog and Repository Settings work. It does not introduce a
second capability model: packs, bindings, precedence, provider compilation, and runtime
application remain unchanged.

## Product model

Capability Center's Effective tab has two target classes:

1. **Live targets** are persisted master sessions and workers. Their provider, origin,
   repository relationship, cwd, desired revision, applied revision, and runtime drift
   remain daemon-authoritative.
2. **Preview targets** are hypothetical UI-started masters or workers at Rookery or one
   registered repository. The user chooses Claude or Codex and Master or Worker. Preview
   origin is always `ui` in Slice 9.

Rookery Settings gains a **Capabilities** tab for broad UI defaults. Repository Settings
continues to own repo-local overrides. Both common surfaces manage only Master/Worker and
UI audiences; Capability Center Assignments remains the lossless editor for Slack,
automation, external, Side, session, worker, repo-shared, and mixed-origin bindings.

## Preview target contract

The public target union becomes:

```ts
export type CapabilityLiveTarget =
  | { kind: "session"; id: string }
  | { kind: "worker"; id: string };

export type CapabilityPreviewTarget =
  | {
      kind: "rookery";
      provider: "claude" | "codex";
      agent: "master" | "worker";
    }
  | {
      kind: "repo";
      id: string;
      provider: "claude" | "codex";
      agent: "master" | "worker";
    };

export type CapabilityTarget = CapabilityLiveTarget | CapabilityPreviewTarget;
```

The protocol accepts exactly these fields. Preview requests cannot supply cwd, origin,
home session, worktree, or arbitrary filesystem paths. A repo preview id must resolve to
an authoritative registered repository. Unknown ids fail instead of degrading to an
empty preview.

`CapabilityService.resolveManaged()` remains restricted to `CapabilityLiveTarget` so a
preview can never be passed into provider-runtime materialization by accident.

## Preview resolution

Both preview kinds use the existing resolver with a synthetic, non-persisted target:

- agent kind comes from `agent`;
- provider comes from `provider`;
- origin is fixed to `ui`;
- Rookery preview has no repo id and therefore resolves only Rookery bindings;
- repository preview carries the authoritative repo id and path and therefore resolves
  repo-local/repo-shared bindings over Rookery defaults using existing precedence;
- session- and worker-scoped bindings never match a preview.

The synthetic target id is never persisted, emitted as a runtime target, or used as a
Codex-home path. Runtime-state inspection is skipped. Launchable managed and built-in
entries remain `desired`; a preview never claims `applied`, `pending-next-turn`, or
`pending-reload`, and preview-only entries expose no invocation action.

Trust, disabled tombstones, required/optional secrets, provider compatibility, and Side
suppression continue to come from the existing resolver. Preview responses contain only
sanitized entries, diagnostics, digests/revisions, and configured booleans.

## Provider-native inventory

A repository preview has one canonical cwd, so it may perform the existing read-only
provider inventory probe at the registered repository path:

- Claude uses the cold command catalog for that cwd;
- Codex uses the structured app-server inventory with the normal base environment, never
  a live target's generated `CODEX_HOME`.

Successful provider entries are projected as `desired`, not `applied`. A partial probe
failure remains a diagnostic while managed and Rookery entries render.

A Rookery-wide preview has no canonical cwd. It is therefore intentionally **scope-only**:
it shows Rookery built-ins and resolved managed defaults, and the UI explains that a
repository or live target is required for provider-native inventory. Rookery preview does
not guess a cwd, inspect a user's arbitrary project, or encode unknown native inventory as
a successful empty provider result.

## Rookery default settings

Rookery Settings adds a Capabilities tab backed by the same sanitized Catalog snapshot and
transactional quick-binding route used by Repository Settings. For each Catalog entry it
can set:

```ts
{
  packInstanceId,
  scopeKind: "rookery",
  scopeRef: "",
  mode: "inherit" | "enabled" | "disabled",
  agents: Array<"master" | "worker">,
}
```

At Rookery scope, `inherit` is presented as “not set” because there is no broader managed
scope. Enabled and disabled rows are the default or tombstone for the selected UI agents.
A mixed-origin or Side overlap remains custom and read-only in this surface, with a deep
link to advanced Assignments.

The reusable scope-binding component owns loading, search, row mutation, pending/error,
trust/secret badges, and custom-conflict behavior. Repository and Rookery wrappers provide
scope-specific copy and preview links rather than duplicating mutation logic.

## Repository inheritance explanation

Repository Settings keeps the explicit `inherit`, `enabled`, and `disabled` controls. Each
row also explains its effective source:

- direct enabled/disabled modes say that the repository overrides the Rookery default;
- inherit shows the simple Rookery default and its Master/Worker audience;
- no broad binding says that no Rookery default exists;
- a custom broad binding is labeled custom and links to advanced Assignments.

This explanation is derived from the sanitized binding list only. It is advisory context;
the authoritative Effective repo preview remains the final answer after precedence,
trust, secrets, and provider compatibility.

## Desktop navigation

The Effective tab always renders a target selector with grouped choices for:

- Rookery preview;
- each registered repository preview;
- each persisted master session;
- each persisted worker.

Preview selections additionally render Claude/Codex and Master/Worker controls. With no
active conversation, Capability Center defaults to Rookery · Claude · Master rather than
showing a dead no-target screen. Opening from a live conversation keeps that live target.

Repository Settings exposes “Preview effective” for that repository. Rookery Settings
exposes the same action for Rookery defaults. Slash-command deep links continue to open the
active live target and exact capability kind. Target changes cancel stale snapshot results,
reset runtime-only controls, and reload on capability generation events.

The target choice is local to the open Capability Center in Slice 9; it is not persisted
across application restarts and does not mutate the shared conversation navigation axes.

## Security and failure semantics

- Preview input never accepts cwd, origin, session id aliases, home ids, or secret values.
- Repo paths come only from authoritative registered rows.
- Preview never creates a session/worker, generated home, runtime revision directory, MCP
  process, provider conversation, binding, or trust decision.
- Preview never calls runtime-state apply/inspect and never reports an applied revision.
- Codex repo preview uses the base provider environment, not any live target home or
  materialized managed secret aliases.
- Provider probe failure is partial; unknown repo/provider/agent input is a correlated
  request error.
- Rookery default mutation preserves Slice 8's atomic replacement and custom-overlap
  refusal.
- Capability events, preview responses, renderer state, diagnostics, and logs contain no
  secret values.

## Data and migration

No database schema or migration changes are required. Slice 9 reuses capability packs,
trust, secrets, bindings, registered repositories, and generation events. Preview targets
are request-scoped values and are never persisted.

## Slice 9 acceptance criteria

1. Capability Center Effective can switch among Rookery, registered repository, live
   master session, and live worker targets.
2. Rookery and repository previews require explicit Claude/Codex and Master/Worker hints,
   use UI origin, and cannot accept client-supplied cwd or origin.
3. Rookery preview resolves broad bindings without probing provider-native inventory and
   clearly explains the scope-only limitation.
4. Repository preview resolves broad plus repository bindings at the authoritative repo
   path, probes the selected provider read-only, and reports launchable entries as desired.
5. Preview never touches runtime state, generated provider homes, runtime materialization,
   provider conversations, bindings, trust, or secret values.
6. Rookery Settings can transactionally set not-set/enabled/disabled defaults for UI
   Master/Worker audiences and refuses lossy custom edits.
7. Repository Settings explains direct overrides versus inherited Rookery defaults and can
   deep-link to its Effective preview.
8. Live session/worker Effective behavior, runtime reload controls, Catalog, advanced
   Assignments, and command deep links remain unchanged.
9. Protocol/core/desktop tests, Korean/English catalog checks, root and desktop gates, an
   isolated daemon smoke, and an Electron visual smoke pass.
