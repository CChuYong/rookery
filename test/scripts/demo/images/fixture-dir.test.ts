import { it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-expect-error -- untyped .mjs demo helper (test/ is not part of the root typecheck)
import { assertTemporaryFixtureDir } from "../../../../scripts/demo/images/fixture-dir.mjs";

const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

it("accepts os.tmpdir(), /tmp, and their realpaths (macOS /private/tmp)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rookery-fixture-"));
  made.push(dir);
  expect(() => assertTemporaryFixtureDir(dir)).not.toThrow();
  expect(() => assertTemporaryFixtureDir(fs.realpathSync(dir))).not.toThrow();
  expect(() => assertTemporaryFixtureDir(path.join(fs.realpathSync("/tmp"), "rookery-not-created-yet"))).not.toThrow();
  expect(() => assertTemporaryFixtureDir("/tmp/rookery-not-created-yet/nested")).not.toThrow();
});

it("rejects directories outside the temp roots, the roots themselves, and escaping symlinks", () => {
  expect(() => assertTemporaryFixtureDir(os.homedir())).toThrow("temporary directory");
  expect(() => assertTemporaryFixtureDir("/tmp")).toThrow("temporary directory");
  expect(() => assertTemporaryFixtureDir("/tmpfoo/x")).toThrow("temporary directory");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rookery-fixture-"));
  made.push(dir);
  fs.symlinkSync(os.homedir(), path.join(dir, "escape"));
  expect(() => assertTemporaryFixtureDir(path.join(dir, "escape"))).toThrow("temporary directory");
});
