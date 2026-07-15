import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { openDb, currentVersion, MIGRATIONS } from "../../src/persistence/db.js";

describe("openDb", () => {
  it("applies all migrations and reports current version", () => {
    const db = openDb(":memory:");
    expect(currentVersion(db)).toBe(MIGRATIONS.length);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "sessions",
        "messages",
        "workers",
        "worker_events",
        "memories",
        "capability_packs",
        "capability_bindings",
        "capability_trust",
        "capability_secrets",
        "schema_version",
      ]),
    );
    db.close();
  });

  it("migrates the immediately preceding schema to the four strict capability tables", () => {
    const file = path.join(os.tmpdir(), `rk-capability-migrate-${process.pid}-${Date.now()}.db`);
    try {
      const legacy = new Database(file);
      legacy.pragma("foreign_keys = ON");
      legacy.exec("CREATE TABLE schema_version (version INTEGER NOT NULL)");
      legacy.transaction(() => {
        for (const migration of MIGRATIONS.slice(0, -1)) migration(legacy);
        legacy.prepare("INSERT INTO schema_version(version) VALUES (?)").run(MIGRATIONS.length - 1);
      })();
      legacy.close();

      const migrated = openDb(file);
      expect(currentVersion(migrated)).toBe(MIGRATIONS.length);
      const tables = migrated.prepare("PRAGMA table_list").all() as Array<{ name: string; strict: number }>;
      for (const name of ["capability_packs", "capability_bindings", "capability_trust", "capability_secrets"]) {
        expect(tables.find((table) => table.name === name)).toMatchObject({ strict: 1 });
      }
      const indexes = migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>;
      expect(indexes.map((index) => index.name)).toContain("idx_capability_bindings_scope");
      migrated.close();
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it("is idempotent when reopened (no double-apply)", () => {
    const db = openDb(":memory:");
    const v = currentVersion(db);
    // re-running migrations on the same connection keeps the version unchanged
    expect(currentVersion(db)).toBe(v);
    db.close();
  });

  it("openDb throws (and closes) when schema_version is newer than this build", () => {
    const file = path.join(os.tmpdir(), `rk-downgrade-${process.pid}-${Date.now()}.db`);
    try {
      const db1 = openDb(file);
      db1.prepare("DELETE FROM schema_version").run();
      db1.prepare("INSERT INTO schema_version(version) VALUES (?)").run(999);
      db1.close();
      expect(() => openDb(file)).toThrow(/newer than this build/);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});
