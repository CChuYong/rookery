import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ImageStore, ImageGcScheduler, IMAGE_GC_GRACE_MS } from "../../src/daemon/image-store.js";
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
    // Distinct names: identical name+bytes would dedupe to one asset instead of testing the quota.
    const results = await Promise.allSettled([
      Promise.resolve().then(() => store.upload({ name: "a", mediaType: "image/png", base64: png })),
      Promise.resolve().then(() => store.upload({ name: "b", mediaType: "image/png", base64: png })),
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

describe("image dedupe and garbage collection", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const bytes = Buffer.from(png, "base64").length;
  function clocked(quotaBytes?: number) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "rookery-image-gc-"));
    homes.push(home);
    const db = openDb(path.join(home, "db"));
    const clock = { ms: Date.parse("2026-01-01T00:00:00.000Z") };
    const repos = new Repositories(db, () => new Date(clock.ms).toISOString());
    const store = new ImageStore(home, repos, { quotaBytes });
    const dir = path.join(home, "images");
    return { home, db, repos, store, clock, dir };
  }

  it("dedupes an identical upload (same bytes, MIME, name) to the same validated ref without growing quota", () => {
    const { store, repos, db, dir } = clocked(bytes);
    const first = store.upload({ name: "shot.png", mediaType: "image/png", base64: png });
    // The quota is exactly one asset: a second copy would be refused, a dedupe hit is not.
    const again = store.upload({ name: "shot.png", mediaType: "image/png", base64: png });
    expect(again).toEqual(first);
    expect(store.validate([again])).toEqual([first]);
    expect(repos.imageBytes()).toBe(bytes);
    expect(fs.readdirSync(dir)).toEqual([first.id]);
    db.close();
  });

  it("stores a different name separately (own row and own file)", () => {
    const { store, repos, db, dir } = clocked();
    const a = store.upload({ name: "a.png", mediaType: "image/png", base64: png });
    const b = store.upload({ name: "b.png", mediaType: "image/png", base64: png });
    expect(b.id).not.toBe(a.id);
    expect(b.name).toBe("b.png");
    expect(store.validate([b])).toEqual([b]);
    expect(repos.imageBytes()).toBe(2 * bytes);
    expect(fs.readdirSync(dir).sort()).toEqual([a.id, b.id].sort());
    db.close();
  });

  it("does not dedupe to a row whose asset is gone or replaced by a symlink", () => {
    const { store, db, dir, home } = clocked();
    const a = store.upload({ name: "a.png", mediaType: "image/png", base64: png });
    fs.unlinkSync(path.join(dir, a.id));
    const b = store.upload({ name: "a.png", mediaType: "image/png", base64: png });
    expect(b.id).not.toBe(a.id);
    fs.renameSync(path.join(dir, b.id), path.join(home, "outside"));
    fs.symlinkSync(path.join(home, "outside"), path.join(dir, b.id));
    const c = store.upload({ name: "a.png", mediaType: "image/png", base64: png });
    expect([a.id, b.id]).not.toContain(c.id);
    expect(store.get(c.id).base64).toBe(png);
    db.close();
  });

  it("deletes an unreferenced image older than the grace window (row + file) and the quota drops", () => {
    const { store, repos, db, dir, clock } = clocked();
    const old = store.upload({ name: "old.png", mediaType: "image/png", base64: png });
    clock.ms += IMAGE_GC_GRACE_MS + 1;
    expect(store.collectGarbage({ now: clock.ms })).toEqual({ deleted: 1, bytes });
    expect(repos.getImage(old.id)).toBeUndefined();
    expect(fs.existsSync(path.join(dir, old.id))).toBe(false);
    expect(repos.imageBytes()).toBe(0);
    expect(() => store.get(old.id)).toThrow("missing");
    db.close();
  });

  it("keeps an unreferenced image younger than the grace window (unsent drafts)", () => {
    const { store, repos, db, dir, clock } = clocked();
    const young = store.upload({ name: "draft.png", mediaType: "image/png", base64: png });
    clock.ms += 6 * DAY;
    expect(store.collectGarbage({ now: clock.ms })).toEqual({ deleted: 0, bytes: 0 });
    expect(store.collectGarbage({ now: clock.ms, graceMs: 7 * DAY })).toEqual({ deleted: 0, bytes: 0 });
    expect(repos.getImage(young.id)).toEqual(young);
    expect(fs.existsSync(path.join(dir, young.id))).toBe(true);
    db.close();
  });

  it("keeps old images referenced by any persisted transcript or retry input", () => {
    const { store, repos, db, dir, clock } = clocked();
    const up = (name: string) => store.upload({ name, mediaType: "image/png", base64: png });
    const [master, worker, retry, workerRetry, message, orphan] = ["m", "w", "r", "wr", "msg", "x"].map((n) => up(`${n}.png`));
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "w1", sessionId: "s1", repoPath: "/x", label: "w" });
    repos.addSessionEvent({ sessionId: "s1", seq: 1, type: "master.message", payloadJson: JSON.stringify({ type: "master.message", role: "user", images: [master] }) });
    repos.addSessionEvent({ sessionId: "s1", seq: 2, type: "error", payloadJson: JSON.stringify({ type: "error", retryInput: { text: "", images: [retry] } }) });
    repos.addWorkerEvent({ workerId: "w1", seq: 1, type: "message", payloadJson: JSON.stringify({ kind: "message", role: "user", images: [worker] }) });
    repos.addWorkerEvent({ workerId: "w1", seq: 2, type: "error", payloadJson: JSON.stringify({ kind: "error", retryInput: { text: "", images: [workerRetry] } }) });
    // messages.content is a plain-text index: a bare id there is not a ref.
    repos.addMessage({ sessionId: "s1", role: "user", content: `image ${message!.id}` });
    clock.ms += 30 * DAY;
    expect(store.collectGarbage({ now: clock.ms })).toEqual({ deleted: 2, bytes: 2 * bytes });
    for (const kept of [master, worker, retry, workerRetry]) {
      expect(store.get(kept!.id).base64).toBe(png);
    }
    expect(repos.getImage(orphan!.id)).toBeUndefined();
    expect(repos.getImage(message!.id)).toBeUndefined();
    expect(fs.readdirSync(dir)).toHaveLength(4);
    // Deleting the session (cascades the worker) releases every reference.
    repos.deleteSession("s1");
    expect(store.collectGarbage({ now: clock.ms })).toEqual({ deleted: 4, bytes: 4 * bytes });
    expect(fs.readdirSync(dir)).toEqual([]);
    db.close();
  });

  it("a dedupe hit or a validated send restarts the grace window", () => {
    const { store, db, clock } = clocked();
    const a = store.upload({ name: "a.png", mediaType: "image/png", base64: png });
    const b = store.upload({ name: "b.png", mediaType: "image/png", base64: png });
    clock.ms += 6 * DAY;
    expect(store.upload({ name: "a.png", mediaType: "image/png", base64: png }).id).toBe(a.id);
    store.validate([b]); // accepted send whose ref is still only queued in memory
    clock.ms += 2 * DAY;
    expect(store.collectGarbage({ now: clock.ms })).toEqual({ deleted: 0, bytes: 0 });
    clock.ms += 6 * DAY;
    expect(store.collectGarbage({ now: clock.ms })).toEqual({ deleted: 2, bytes: 2 * bytes });
    db.close();
  });

  it("never follows a symlinked asset and only deletes inside the images dir", () => {
    const { store, repos, db, dir, home, clock } = clocked();
    const a = store.upload({ name: "a.png", mediaType: "image/png", base64: png });
    const outside = path.join(home, "precious");
    fs.writeFileSync(outside, "keep");
    fs.unlinkSync(path.join(dir, a.id));
    fs.symlinkSync(outside, path.join(dir, a.id));
    clock.ms += 8 * DAY;
    expect(store.collectGarbage({ now: clock.ms })).toEqual({ deleted: 0, bytes: 0 });
    expect(fs.readFileSync(outside, "utf8")).toBe("keep");
    expect(fs.lstatSync(path.join(dir, a.id)).isSymbolicLink()).toBe(true);
    expect(repos.getImage(a.id)).toBeDefined();
    db.close();
  });

  it("drops metadata whose asset is already missing and keeps quota accounting consistent", () => {
    const { store, repos, db, dir, clock } = clocked(bytes * 2);
    const a = store.upload({ name: "a.png", mediaType: "image/png", base64: png });
    const b = store.upload({ name: "b.png", mediaType: "image/png", base64: png });
    expect(() => store.upload({ name: "c.png", mediaType: "image/png", base64: png })).toThrow("quota");
    fs.unlinkSync(path.join(dir, a.id));
    clock.ms += 8 * DAY;
    expect(store.collectGarbage({ now: clock.ms })).toEqual({ deleted: 2, bytes: 2 * bytes });
    expect(repos.getImage(b.id)).toBeUndefined();
    // Reclaimed bytes are usable again; a failed unlink would have stayed reserved.
    store.upload({ name: "c.png", mediaType: "image/png", base64: png });
    const d = store.upload({ name: "d.png", mediaType: "image/png", base64: png });
    clock.ms += 8 * DAY;
    const unlink = vi.spyOn(fs, "unlinkSync").mockImplementation(() => { throw Object.assign(new Error("busy"), { code: "EBUSY" }); });
    expect(store.collectGarbage({ now: clock.ms }).deleted).toBe(2);
    unlink.mockRestore();
    expect(repos.imageBytes()).toBe(0);
    expect(fs.existsSync(path.join(dir, d.id))).toBe(true);
    expect(() => store.upload({ name: "e.png", mediaType: "image/png", base64: png })).toThrow("quota");
    db.close();
  });
});

describe("ImageGcScheduler", () => {
  it("coalesces triggers into one deferred run, logs a one-line summary and swallows failures", () => {
    vi.useFakeTimers();
    try {
      const lines: string[] = [];
      const run = vi.fn(() => ({ deleted: 2, bytes: 140 }));
      const scheduler = new ImageGcScheduler({ collectGarbage: run }, { delayMs: 50, log: (l) => lines.push(l) });
      scheduler.schedule();
      scheduler.schedule();
      scheduler.schedule();
      expect(run).not.toHaveBeenCalled();
      vi.advanceTimersByTime(50);
      expect(run).toHaveBeenCalledTimes(1);
      expect(lines).toEqual(["[rookery] image gc: removed 2 unreferenced image(s), 140 bytes\n"]);
      // A delete-triggered pass that removes nothing stays quiet; the boot pass always reports.
      run.mockImplementationOnce(() => ({ deleted: 0, bytes: 0 }));
      scheduler.schedule();
      vi.advanceTimersByTime(50);
      expect(lines).toHaveLength(1);
      run.mockImplementationOnce(() => ({ deleted: 0, bytes: 0 }));
      scheduler.schedule("delete");
      scheduler.schedule("boot");
      vi.advanceTimersByTime(50);
      expect(lines[1]).toBe("[rookery] image gc: removed 0 unreferenced image(s), 0 bytes\n");
      run.mockImplementationOnce(() => { throw new Error("db closed"); });
      scheduler.schedule();
      vi.advanceTimersByTime(50);
      expect(lines[2]).toMatch(/^\[rookery\] image gc failed: .*db closed/);
      expect(run).toHaveBeenCalledTimes(4);
      scheduler.schedule();
      scheduler.stop();
      vi.advanceTimersByTime(50);
      expect(run).toHaveBeenCalledTimes(4);
      scheduler.schedule(); // stopped: no further runs
      vi.advanceTimersByTime(50);
      expect(run).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });
});
