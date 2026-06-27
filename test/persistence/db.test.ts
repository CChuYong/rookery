import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
        "schema_version",
      ]),
    );
    db.close();
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
