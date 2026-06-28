# Add a DB Migration (schema change)

> **Source of truth:** `src/persistence/db.ts`, `src/persistence/repositories.ts`, `test/persistence/db.test.ts` — the code is authoritative; this doc explains concepts and flows. The always-loaded map/conventions live in [AGENTS.md](../../AGENTS.md); this goes deeper.

Persistence is `better-sqlite3` (synchronous) with `WAL` + `foreign_keys=ON` + **`STRICT` tables**. Migrations are an **append-only array** `MIGRATIONS` in `src/persistence/db.ts:10`, where **the array index is the schema version**. `openDb` applies every migration from the stored `schema_version` up to `MIGRATIONS.length` in one transaction (`src/persistence/db.ts:161`). The full table catalog is in [../reference/data-model.md](../reference/data-model.md).

## The squashed baseline

There is currently exactly **one** entry in `MIGRATIONS` — a single CREATE-only baseline (the pre-release history was squashed; `src/persistence/db.ts:6-9`). Because the app is pre-release with no deployed databases, the baseline is edited in place when adding columns/tables *before release*. **Post-release**, the baseline becomes frozen and every change is a **new appended entry**. When in doubt, append — it's always safe.

## The cardinal rule

**Append only. Never modify an existing `MIGRATIONS` entry.** Each entry runs exactly once per database, at the version equal to its index. Editing entry `0` after a DB has applied it means that DB never sees your change (it already recorded version ≥ 1). `test/persistence/db.test.ts:8` asserts `currentVersion(db) === MIGRATIONS.length`, and `openDb` throws if a DB's stored version is *newer* than the build (`src/persistence/db.ts:163`) — so versions only ever move forward.

## Recipe: add a column (post-release)

1. **Append a function to `MIGRATIONS`** (`src/persistence/db.ts:10`). Its index = the new version. Example:
   ```ts
   (db) => {
     db.exec(`ALTER TABLE workers ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;`);
   },
   ```
   Keep it forward-only; the whole array runs in one transaction so a throw rolls back cleanly.
2. **Respect STRICT-table ALTER constraints.** SQLite `ALTER TABLE … ADD COLUMN` on a STRICT table requires the column be one of the STRICT storage classes (`INTEGER`/`REAL`/`TEXT`/`BLOB`/`ANY`) and, if `NOT NULL`, it **must have a `DEFAULT`** (no per-row backfill value otherwise). You cannot add a `NOT NULL` column without a default, and you cannot add a `PRIMARY KEY`/`UNIQUE` column via ALTER. For complex reshapes do the table-rebuild dance (create new table → `INSERT INTO … SELECT` → drop → rename) inside one migration function.
3. **Update the row type + repository methods** in `src/persistence/repositories.ts`. Add the field to the relevant interface (e.g. the worker/`WorkerRow` mapping), include the column in the `INSERT`/`UPDATE`/`SELECT` statements, and add accessor methods. All DB access goes through `Repositories` — nothing else touches SQL.
4. **If the value crosses the wire**, also update `src/protocol/messages.ts` (e.g. `WorkerRow`) and the desktop — see [add-a-protocol-message.md](add-a-protocol-message.md).

## Gotchas

- **Index = version, append-only.** Adding an entry bumps `MIGRATIONS.length`, which is what the version asserts.
- **STRICT means typed.** Only the STRICT storage classes are allowed; `NOT NULL` needs a `DEFAULT`. A type mismatch throws at write time, not migration time.
- **`foreign_keys=ON`** — new `REFERENCES` columns are enforced. Order inserts/deletes accordingly; the worker write-once guard lives in `repos.setWorkerStatus` (`src/persistence/repositories.ts`), not in SQL.
- **One transaction.** If any appended migration throws, `openDb` closes the DB and rethrows (`src/persistence/db.ts:172`) — the partial migration is rolled back. Test on a throwaway DB first.
- ESM NodeNext: `.js` extensions, `import type`.
- Node 22 ABI — `better-sqlite3` is built for ABI 127; run everything under Node 22 (see [AGENTS.md](../../AGENTS.md)).

## Test & gate

`test/persistence/db.test.ts` is the guardrail: it asserts the version equals `MIGRATIONS.length`, that expected tables exist, and that a future-versioned DB is rejected. Add assertions there for your new table/column. Repository tests use `openDb(":memory:")` + `new Repositories(db, now?)` with an injected clock for deterministic timestamps. Then:

```bash
npm run typecheck
npm test
npx vitest run test/persistence/db.test.ts   # the version===length guard
```

Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
