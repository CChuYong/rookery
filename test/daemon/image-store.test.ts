import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ImageStore } from "../../src/daemon/image-store.js";
import { openDb } from "../../src/persistence/db.js";
import { Repositories } from "../../src/persistence/repositories.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { EventBus } from "../../src/core/events.js";
import { fakeBackend } from "../helpers/fake-query.js";
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9f8AAAAASUVORK5CYII=";
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    fs.rmSync(home, { recursive: true, force: true });
});
function setup(quotaBytes?: number) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rookery-image-"));
  homes.push(home);
  const db = openDb(path.join(home, "db"));
  const repos = new Repositories(db);
  return {
    home,
    db,
    repos,
    store: new ImageStore(home, repos, { quotaBytes }),
  };
}
describe("immutable image store", () => {
  it("stores authoritative bounded bytes and reopens with private modes", () => {
    const { home, db, store } = setup();
    const ref = store.upload({
      name: "../../a\n.png",
      mediaType: "image/png",
      base64: png,
    });
    expect(ref).toMatchObject({
      mediaType: "image/png",
      width: 1,
      height: 1,
      byteLength: Buffer.from(png, "base64").length,
    });
    expect(ref.name).not.toMatch(/[\/\n]/);
    expect(store.get(ref.id).base64).toBe(png);
    expect(fs.statSync(path.join(home, "images", ref.id)).mode & 0o777).toBe(
      0o600,
    );
    db.close();
    const reopened = openDb(path.join(home, "db"));
    expect(
      new ImageStore(home, new Repositories(reopened)).get(ref.id).image,
    ).toEqual(ref);
    reopened.close();
  });
  it("rejects MIME mismatch, noncanonical/oversized data, invalid dimensions and ids", () => {
    const { store, db } = setup();
    for (const input of [
      { name: "a", mediaType: "image/jpeg", base64: png },
      { name: "a", mediaType: "image/png", base64: png + "\n" },
      {
        name: "a",
        mediaType: "image/png",
        base64: "A".repeat(4 * 1024 * 1024 + 4),
      },
    ])
      expect(() => store.upload(input)).toThrow();
    const large = Buffer.from(png, "base64");
    large.writeUInt32BE(8001, 16);
    expect(() =>
      store.upload({
        name: "a",
        mediaType: "image/png",
        base64: large.toString("base64"),
      }),
    ).toThrow();
    expect(() => store.get("../db")).toThrow();
    db.close();
  });
  it("enforces quota across uploads without deleting assets; rejects tampered refs/symlinks", async () => {
    const { store, db, home } = setup(Buffer.from(png, "base64").length);
    const input = { name: "a", mediaType: "image/png", base64: png };
    const results = await Promise.allSettled([
      Promise.resolve().then(() => store.upload(input)),
      Promise.resolve().then(() => store.upload(input)),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const ref = (
      results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<
        ReturnType<ImageStore["upload"]>
      >
    ).value;
    expect(store.get(ref.id).base64).toBe(png);
    expect(() => store.validate([{ ...ref, name: "lie" }])).toThrow();
    fs.unlinkSync(path.join(home, "images", ref.id));
    fs.symlinkSync(path.join(home, "db"), path.join(home, "images", ref.id));
    expect(() => store.get(ref.id)).toThrow();
    db.close();
  });
});

it("parses real PNG/JPEG/WebP/GIF fixtures and preserves exact bytes", () => {
  const { store, db } = setup();
  for (const [extension, mediaType] of [
    ["png", "image/png"],
    ["jpg", "image/jpeg"],
    ["webp", "image/webp"],
    ["gif", "image/gif"],
  ]) {
    const bytes = fs.readFileSync(
      new URL(`../fixtures/images/tiny.${extension}`, import.meta.url),
    );
    const ref = store.upload({
      name: `tiny.${extension}`,
      mediaType,
      base64: bytes.toString("base64"),
    });
    expect(ref).toMatchObject({
      width: 2,
      height: 3,
      mediaType,
      byteLength: bytes.length,
    });
    expect(store.get(ref.id).base64).toBe(bytes.toString("base64"));
  }
  db.close();
});
it("enforces exact byte, dimension and pixel boundaries with bounded maximum data", () => {
  const { store, db } = setup();
  const bytes = Buffer.alloc(3 * 1024 * 1024);
  Buffer.from(png, "base64").copy(bytes);
  const ref = store.upload({
    name: "max.png",
    mediaType: "image/png",
    base64: bytes.toString("base64"),
  });
  expect(ref.byteLength).toBe(bytes.length);
  expect(() =>
    store.upload({
      name: "large.png",
      mediaType: "image/png",
      base64: Buffer.concat([bytes, Buffer.from([0])]).toString("base64"),
    }),
  ).toThrow("3 MiB");
  for (const [width, height, valid] of [
    [8000, 2500, true],
    [8001, 1, false],
    [5000, 4001, false],
    [1, 8001, false],
    [0, 1, false],
  ]) {
    const header = Buffer.from(png, "base64");
    header.writeUInt32BE(width, 16);
    header.writeUInt32BE(height, 20);
    const upload = () =>
      store.upload({
        name: "dimensions.png",
        mediaType: "image/png",
        base64: header.toString("base64"),
      });
    if (valid) expect(upload().width).toBe(width);
    else expect(upload).toThrow();
  }
  expect(() =>
    store.upload({ name: "bad.png", mediaType: "image/png", base64: "AB==" }),
  ).toThrow("canonical");
  expect(() =>
    store.upload({
      name: "bad.png",
      mediaType: "image/png",
      base64: Buffer.from('<svg width="1" height="1"></svg>').toString(
        "base64",
      ),
    }),
  ).toThrow();
  db.close();
});
it("rolls back owned files on metadata failure and refuses symlink directories/non-file assets", () => {
  const { store, db, repos, home } = setup();
  const add = repos.addImage.bind(repos);
  repos.addImage = () => {
    throw new Error("db failed");
  };
  expect(() =>
    store.upload({ name: "a", mediaType: "image/png", base64: png }),
  ).toThrow("db failed");
  expect(fs.readdirSync(path.join(home, "images"))).toEqual([]);
  expect(repos.imageBytes()).toBe(0);
  repos.addImage = add;
  const ref = store.upload({ name: "a", mediaType: "image/png", base64: png });
  fs.unlinkSync(path.join(home, "images", ref.id));
  fs.mkdirSync(path.join(home, "images", ref.id));
  expect(() => store.get(ref.id)).toThrow("unreadable");
  fs.renameSync(path.join(home, "images"), path.join(home, "original"));
  fs.symlinkSync(path.join(home, "original"), path.join(home, "images"));
  expect(() => store.get(ref.id)).toThrow("symlink");
  expect(() => new ImageStore(home, repos)).toThrow("symlink");
  db.close();
});
it("rejects incorrect full signatures and counts crash-orphaned files against quota without deleting them", () => {
  const { store, home, db } = setup(100);
  const malformed = Buffer.from(png, "base64");
  malformed[0] = 0;
  expect(() =>
    store.upload({
      name: "bad.png",
      mediaType: "image/png",
      base64: malformed.toString("base64"),
    }),
  ).toThrow("signature");
  fs.writeFileSync(path.join(home, "images", ".crash.tmp"), Buffer.alloc(50), {
    mode: 0o600,
  });
  expect(() =>
    store.upload({ name: "a.png", mediaType: "image/png", base64: png }),
  ).toThrow("quota");
  expect(fs.statSync(path.join(home, "images", ".crash.tmp")).size).toBe(50);
  db.close();
});

it("rolls back file-creation failure and keeps forked refs after deleting the original target", async () => {
  const { store, repos, home, db } = setup();
  const link = vi.spyOn(fs, "linkSync").mockImplementationOnce(() => {
    throw new Error("disk failed");
  });
  expect(() =>
    store.upload({ name: "a", mediaType: "image/png", base64: png }),
  ).toThrow("disk failed");
  link.mockRestore();
  expect(repos.imageBytes()).toBe(0);
  expect(fs.readdirSync(path.join(home, "images"))).toEqual([]);
  const image = store.upload({
    name: "a",
    mediaType: "image/png",
    base64: png,
  });
  const backend = fakeBackend([
    {
      type: "result",
      subtype: "success",
      total_cost_usd: 0,
      num_turns: 1,
      session_id: "sdk",
    },
  ]);
  const sessions = new SessionManager({
    images: store,
    repos,
    bus: new EventBus(),
    backends: { claude: backend },
    masterModel: "m",
    fleet: {} as never,
    forkSession: async () => ({ sessionId: "fork-sdk" }),
  });
  const source = sessions.create("/tmp");
  await source.master.runTurn("", { images: [image] });
  const fork = await sessions.fork(source.id);
  await sessions.delete(source.id);
  expect(store.get(image.id).base64).toBe(png);
  expect(JSON.stringify(repos.listSessionEvents(fork.id))).toContain(image.id);
  expect(JSON.stringify(repos.listSessionEvents(fork.id))).not.toContain(png);
  await fork.master.runTurn("inspect again", { images: [image] });
  await sessions.delete(fork.id);
  expect(store.get(image.id).base64).toBe(png);
  db.close();
});

it("resolves a symlinked home but still refuses a symlinked images directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rookery-image-home-"));
  homes.push(root);
  const real = path.join(root, "real");
  fs.mkdirSync(real);
  fs.symlinkSync(real, path.join(root, "link"));
  const db = openDb(":memory:");
  const store = new ImageStore(path.join(root, "link"), new Repositories(db));
  const ref = store.upload({ name: "a.png", mediaType: "image/png", base64: png });
  expect(fs.existsSync(path.join(real, "images", ref.id))).toBe(true);
  expect(store.get(ref.id).base64).toBe(png);
  fs.renameSync(path.join(real, "images"), path.join(real, "images-real"));
  fs.symlinkSync(path.join(real, "images-real"), path.join(real, "images"));
  expect(() => new ImageStore(path.join(root, "link"), new Repositories(db))).toThrow("symlink");
  db.close();
});

it("checks quota from an aggregate after one leftover scan, keeping rollback leftovers counted", () => {
  const bytes = Buffer.from(png, "base64").length;
  const { store, home, db } = setup(bytes * 3);
  fs.writeFileSync(path.join(home, "images", ".crash.tmp"), Buffer.alloc(bytes), { mode: 0o600 });
  const readdir = vi.spyOn(fs, "readdirSync");
  store.upload({ name: "a.png", mediaType: "image/png", base64: png });
  // A failed rollback (destination unlink fails after a metadata error) stays reserved.
  const add = vi.spyOn(Repositories.prototype, "addImage").mockImplementationOnce(() => { throw new Error("db failed"); });
  const unlink = vi.spyOn(fs, "unlinkSync").mockImplementationOnce(() => { throw new Error("unlink failed"); });
  expect(() => store.upload({ name: "b.png", mediaType: "image/png", base64: png })).toThrow("db failed");
  add.mockRestore();
  unlink.mockRestore();
  expect(() => store.upload({ name: "c.png", mediaType: "image/png", base64: png })).toThrow("quota");
  expect(readdir.mock.calls.filter((c) => String(c[0]).endsWith("images"))).toHaveLength(1);
  readdir.mockRestore();
  db.close();
});
