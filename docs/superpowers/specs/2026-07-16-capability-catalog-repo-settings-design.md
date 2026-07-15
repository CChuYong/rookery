# Capability Catalog and Repository Settings Design

Status: accepted for Slice 8 implementation

## Goal

Let users register one MCP server or one Agent Skill as a lightweight reusable
capability, then bind registered capabilities from a full-page settings surface for each
repository. Keep capability packs as the internal trust, versioning, and runtime unit
without requiring users to understand packs for the common single-capability flow.

The Repository Settings shell must be a durable product surface. Slice 8 ships its
Capabilities section, while later slices may add worktree creation hooks, branch naming,
and other repository policy without replacing the page or its navigation model.

## Product model

The UI has three distinct layers:

1. **Catalog** defines what is available. It contains lightweight MCP and Skill entries,
   plus imported multi-capability bundles.
2. **Assignments** define where catalog entries apply. Repository Settings owns the
   common repo-local/UI assignment flow; Capability Center retains the advanced editor
   for Rookery, repo-shared, session, worker, and non-UI audiences.
3. **Effective** shows what a selected running target actually receives after precedence,
   audience, trust, secrets, and runtime state are resolved.

Registration and assignment are intentionally separate. Creating a lightweight MCP or
importing a Skill never silently enables it for a repository.

## Internal representation

No new runtime abstraction is introduced. Lightweight catalog entries are singleton
Rookery-generated packs:

- one MCP registration produces a pack whose manifest contains exactly one
  `mcpServers` entry;
- one Skill import produces a pack whose manifest contains exactly one `skills` entry
  and a private snapshot of the selected Skill directory;
- existing packs containing multiple capabilities remain bundles and are assigned
  atomically in Slice 8.

This preserves exact-digest trust, write-only secrets, immutable provider compilation,
runtime revisions, worker reload state, and contained generated-pack cleanup.

Catalog presentation is derived from the manifest:

- exactly one MCP and no other content: `mcp`;
- exactly one Skill and no other content: `skill`;
- every other manifest: `bundle`.

## Lightweight registration

### MCP

`capabilities.mcp.create` accepts a display name, stable id, description, one strict
stdio or Streamable HTTP server specification, and optional write-only secret values.
The daemon creates and registers a singleton generated pack. No binding is created.

### Skill

`capabilities.skill.create` accepts a selected local Skill directory plus a stable id,
display name, and description. The generated-pack store copies the directory without
following symlinks, writes a manifest that references the private copy, validates the
complete staged pack, and atomically installs it. Validation rejects missing/invalid
`SKILL.md`, traversal, escaping symlinks, size bounds, and malformed frontmatter through
the existing pack validator. No binding is created.

Both flows are fail-closed and initially untrusted. The Catalog highlights the new entry,
shows its exact files/command/URL/secrets, and reuses the existing review-before-trust
control. A failed create removes registry state, write-only values, and owned staged/final
directories.

## Quick repository assignment

Repository Settings manages a deliberately narrow audience:

- scope: the selected registered repository's `repo-local` scope;
- origin: `ui`;
- agents: `master`, `worker`, or both;
- mode: `inherit`, `enabled`, or `disabled`.

The three modes are not interchangeable:

- `inherit` removes the simple repo-local/UI override so broader assignments resolve;
- `enabled` writes an enabled repo-local/UI binding;
- `disabled` writes a disabled repo-local/UI tombstone that suppresses broader bindings.

`capabilities.binding.quickSet` canonicalizes all simple UI-only master/worker bindings
for one pack and exact scope into zero or one binding. The persistence replacement is one
SQLite transaction. A binding that mixes UI with Slack/automation/external, includes Side,
or otherwise overlaps the managed audience is a custom assignment: quick editing refuses
to overwrite it and directs the user to Capability Center's advanced Assignments tab.

The same service contract accepts `rookery` scope so a later Rookery-defaults surface can
reuse it without another protocol redesign. Slice 8's Repository Settings invokes only
`repo-local`.

## Desktop information architecture

### Capability Center Catalog

The existing Library tab is relabeled Catalog. Its primary actions are:

- Add MCP
- Import Skill
- Build MCP Pack
- Import Pack

Entries render as a searchable list with MCP, Skill, or Bundle badges. Expanded review,
trust, secret, refresh, source, digest, and deletion controls retain their current safety
semantics. The multi-server MCP Pack builder remains available as an advanced bundle flow.

### Repos entry point

Each registered repository header in the Repos tree gets a settings button beside spawn
and remove. The button opens a full main-area `repoSettings` location keyed by the
authoritative repository id; it is not a dialog or right sidebar.

### Repository Settings shell

The page owns:

- repository name and canonical path in its header;
- close/back behavior through the shared navigation history;
- a section navigation rail backed by an explicit section registry;
- a scrollable section body.

Slice 8 registers one section, Capabilities. Future Worktrees, Hooks, Branches, and other
sections add registry entries and focused components without changing the page shell.
No disabled or dead future menu items are rendered in Slice 8.

### Capabilities section

The section loads the sanitized catalog and displays every entry with:

- kind, name, description, provider compatibility, trust, and missing-secret state;
- assignment mode (`inherit`, `enabled`, `disabled`);
- master/worker audience controls for explicit modes;
- a custom-assignment warning and advanced Assignments deep link when quick editing would
  be lossy.

Changes are applied per catalog entry with an in-row pending/error state. Capability
generation events refresh both this page and Capability Center. Existing running workers
continue to use the established `pending-reload` flow; Repository Settings never restarts
a busy worker automatically.

## Navigation state

`repoSettings` is a first-class full-page overlay. The renderer `Location` includes a
nullable `repoId`, participates in equality/back/forward/reset, and is validated against
the current registered-repo list during restoration. Opening or closing Repository
Settings must not alter the active session or worker selection.

## Security and failure semantics

- Secret values remain write-only and never appear in protocol responses, events, logs,
  generated manifests, or renderer state.
- Skill import copies without following symlinks and validates the staged copy before
  atomic rename.
- New catalog entries are untrusted until their exact digest is reviewed.
- Quick assignment never mutates custom or non-UI audiences.
- Repository removal makes a stale settings route close safely and existing persistence
  cleanup continues to remove repo-local bindings.
- Provider compilation remains provider-neutral; the UI does not ask users to choose
  Claude or Codex for a portable MCP or Skill.

## Slice 8 acceptance criteria

1. A user can register one stdio or Streamable HTTP MCP without selecting a repository or
   constructing a multi-server pack.
2. A user can import one valid `SKILL.md` directory into the Catalog.
3. Both entries are secret-safe, initially untrusted singleton generated packs and can be
   reviewed and trusted using the existing exact-digest flow.
4. Every registered repository exposes a settings affordance that opens a full-page,
   repository-keyed settings shell.
5. The Capabilities section lists MCP, Skill, and Bundle entries and can set repo-local/UI
   mode to inherit, enabled, or disabled for master/worker audiences.
6. Quick assignment replacement is atomic and refuses to overwrite custom overlapping
   assignments.
7. Navigation, Korean/English catalogs, protocol correlation, generated directory
   containment, and existing pack/runtime behavior remain covered by automated tests.
8. Root and desktop typechecks, test suites, builds, and an Electron/daemon live smoke pass.

