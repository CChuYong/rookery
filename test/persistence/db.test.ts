import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
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

  it("the origin migration backfills origin/origin_ref from external_key prefixes", () => {
    const db = new Database(":memory:");
    MIGRATIONS[0]!(db); // baseline schema (sessions — before the origin/pinned columns)
    const ins = db.prepare("INSERT INTO sessions(id,cwd,status,external_key,created_at,updated_at) VALUES (?,?,?,?,?,?)");
    ins.run("s_slack", "/x", "active", "slack:T1:C1:9.9", "t", "t");
    ins.run("s_auto", "/x", "active", "automation:auto1", "t", "t");
    ins.run("s_ui", "/x", "active", null, "t", "t");
    for (let v = 1; v < MIGRATIONS.length; v++) MIGRATIONS[v]!(db); // the rest (origin backfill + later additions)
    const get = (id: string) => db.prepare("SELECT origin, origin_ref FROM sessions WHERE id=?").get(id);
    expect(get("s_slack")).toEqual({ origin: "slack", origin_ref: "T1:C1:9.9" });
    expect(get("s_auto")).toEqual({ origin: "automation", origin_ref: "auto1" });
    expect(get("s_ui")).toEqual({ origin: "ui", origin_ref: null });
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
