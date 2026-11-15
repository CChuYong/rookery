import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { imageSize } from "image-size";
import {
  IMAGE_LIMITS,
  assertImageId,
  validateImageRefs,
  type ImageRef,
  type ImageResolver,
  type ImageMediaType,
  type ResolvedImage,
} from "../core/image-input.js";
import type { Repositories } from "../persistence/repositories.js";
const MIME: Record<string, ImageMediaType> = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};
// Exact magic checks complement image-size's dimensions parser (its PNG detector skips byte 0).
// These fixed comparisons do not decode pixels or implement image-header traversal.
function matchesSignature(bytes: Buffer, mime: string): boolean {
  if (mime === "image/png")
    return bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === "image/jpeg")
    return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mime === "image/gif")
    return ["GIF87a", "GIF89a"].includes(
      bytes.subarray(0, 6).toString("latin1"),
    );
  if (mime === "image/webp")
    return (
      bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
      bytes.subarray(8, 12).toString("latin1") === "WEBP"
    );
  return false;
}
// Unreferenced images younger than this survive GC: they may sit in an unsent (persisted) desktop draft,
// which no transcript references yet. A dedupe hit or a validated send restarts the window.
export const IMAGE_GC_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
export interface ImageGcResult {
  deleted: number;
  // Metadata bytes released from the quota (authoritative byte_length of the deleted rows).
  bytes: number;
}
export interface ImageUpload {
  name: string;
  mediaType: string;
  base64: string;
}
// All reservation, creation and metadata writes are synchronous: no concurrent upload can pass
// the quota check before the previous upload commits or rolls back. This store has one daemon owner.
export class ImageStore implements ImageResolver {
  private readonly home: string;
  private readonly directory: string;
  // Bytes on disk not covered by committed metadata (crash leftovers, failed rollbacks). Scanned once,
  // lazily, then kept current in-process so the per-upload quota check is a single DB aggregate.
  private leftoverBytes: number | null = null;
  constructor(
    home: string,
    private readonly repos: Repositories,
    private readonly options: { quotaBytes?: number } = {},
  ) {
    // A symlinked Rookery home (e.g. ~/.rookery -> /Volumes/x/rookery) is a legitimate layout: resolve it
    // once up front. Symlinks INSIDE the store (the images dir itself, asset files) are still rejected.
    this.home = fs.realpathSync(home);
    this.directory = path.join(this.home, "images");
    if (!fs.lstatSync(this.home).isDirectory())
      throw new Error("Image home must be a real directory");
    if (!fs.existsSync(this.directory))
      fs.mkdirSync(this.directory, { mode: 0o700 });
    this.checkDirectory();
    fs.chmodSync(this.directory, 0o700);
  }
  private checkDirectory(): void {
    for (const directory of [this.home, this.directory])
      if (!fs.lstatSync(directory).isDirectory())
        throw new Error("Image directory cannot be a symlink");
  }
  private reservedBytes(): number {
    // Count crash leftovers conservatively as well as authoritative metadata. Never collect them
    // implicitly: an interrupted commit must not make the total storage quota disappear on reboot.
    if (this.leftoverBytes === null) {
      let leftover = 0;
      for (const name of fs.readdirSync(this.directory)) {
        const stat = fs.lstatSync(path.join(this.directory, name));
        if (!stat.isFile())
          throw new Error("Image storage contains an unexpected non-file entry");
        const committed = this.repos.getImage(name);
        leftover += Math.max(0, stat.size - (committed?.byteLength ?? 0));
      }
      this.leftoverBytes = leftover;
    }
    return this.repos.imageBytes() + this.leftoverBytes;
  }
  upload(input: ImageUpload): ImageRef {
    this.checkDirectory();
    // Bound encoded input BEFORE decoding; canonical encoding excludes whitespace and alternate padding.
    if (input.base64.length > 4 * Math.ceil(IMAGE_LIMITS.fileBytes / 3))
      throw new Error("Image exceeds 3 MiB limit");
    if (input.base64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(input.base64))
      throw new Error("Image must use canonical base64");
    const bytes = Buffer.from(input.base64, "base64");
    if (!bytes.length || bytes.toString("base64") !== input.base64)
      throw new Error("Image must use canonical base64");
    if (!matchesSignature(bytes, input.mediaType))
      throw new Error("Image MIME does not match PNG/JPEG/WebP/GIF signature");
    let dimensions: ReturnType<typeof imageSize>;
    try {
      dimensions = imageSize(bytes);
    } catch {
      throw new Error("Invalid image header");
    }
    const mediaType = MIME[dimensions.type ?? ""];
    if (!mediaType || mediaType !== input.mediaType)
      throw new Error("Image MIME does not match PNG/JPEG/WebP/GIF signature");
    const name =
      input.name
        .split(/[\\/]/)
        .pop()!
        .replace(/[\x00-\x1f\x7f]/g, "")
        .slice(0, 200)
        .trim() || "image";
    // Dedupe: identical bytes + MIME + sanitized name return the existing authoritative ref (so validate()
    // passes for the caller's name/mediaType) without a new file or quota growth. A different name gets its
    // own row AND its own file: rows stay immutable and quota stays a plain sum (no shared-inode accounting).
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    for (const existing of this.repos.findImagesByContent(sha256, mediaType, name)) {
      if (!this.assetPresent(existing)) continue;
      this.repos.touchImage(existing.id);
      return existing;
    }
    const ref: ImageRef = {
      id: randomUUID(),
      name,
      mediaType,
      byteLength: bytes.length,
      width: dimensions.width,
      height: dimensions.height,
    };
    validateImageRefs([ref]);
    if (
      this.reservedBytes() + bytes.length >
      (this.options.quotaBytes ?? IMAGE_LIMITS.quotaBytes)
    )
      throw new Error(
        "Image asset quota reached (1 GiB); existing images are retained",
      );
    const destination = path.join(this.directory, ref.id);
    const temporary = path.join(this.directory, `.${randomUUID()}.tmp`);
    let linked = false;
    try {
      const fd = fs.openSync(
        temporary,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_NOFOLLOW,
        0o600,
      );
      try {
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      // link is atomic and fails if the destination exists; rename could replace an existing asset.
      fs.linkSync(temporary, destination);
      linked = true;
      this.repos.addImage(ref, sha256);
    } catch (error) {
      if (linked) {
        try {
          fs.unlinkSync(destination);
        } catch {
          // Rollback failed: the uncommitted asset still occupies disk, so keep it in the quota.
          this.leftoverBytes = (this.leftoverBytes ?? 0) + bytes.length;
        }
      }
      throw error;
    } finally {
      try {
        fs.unlinkSync(temporary);
      } catch (error) {
        // ENOENT: no temporary file was created. Anything else leaves bytes on disk; count them.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" && fs.existsSync(temporary))
          this.leftoverBytes = (this.leftoverBytes ?? 0) + bytes.length;
      }
    }
    return ref;
  }
  // Regular file (never a symlink) of exactly the committed size.
  private assetPresent(image: ImageRef): boolean {
    try {
      const stat = fs.lstatSync(path.join(this.directory, image.id));
      return stat.isFile() && stat.size === image.byteLength;
    } catch {
      return false;
    }
  }
  // Reclaim images that are older than the grace window (by last use, else creation) AND not referenced by
  // any persisted transcript (session/worker events incl. retry inputs, messages). Synchronous, like upload,
  // so it can never interleave with a quota reservation. Only regular files directly inside the images dir
  // are unlinked; a symlinked or non-file entry keeps both its row and its entry. Crash leftovers (files
  // without a row, temporaries) are outside this policy and stay counted against the quota.
  collectGarbage(options: { graceMs?: number; now?: number } = {}): ImageGcResult {
    this.checkDirectory();
    const cutoff = new Date(
      (options.now ?? Date.now()) - (options.graceMs ?? IMAGE_GC_GRACE_MS),
    ).toISOString();
    const candidates = this.repos.imageGcCandidates(cutoff);
    const result: ImageGcResult = { deleted: 0, bytes: 0 };
    if (!candidates.length) return result;
    const referenced = this.repos.referencedImageIds(
      new Set(candidates.map((candidate) => candidate.id)),
    );
    for (const candidate of candidates) {
      if (referenced.has(candidate.id)) continue;
      try {
        assertImageId(candidate.id); // never join a non-UUID row id into a path
      } catch {
        continue;
      }
      const file = path.join(this.directory, candidate.id);
      let stat: fs.Stats | undefined;
      try {
        stat = fs.lstatSync(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
      }
      if (stat && !stat.isFile()) continue;
      this.repos.deleteImage(candidate.id);
      result.deleted += 1;
      result.bytes += candidate.byteLength;
      if (!stat) continue;
      // Keep the cached leftover count exact: this file contributed max(0, size - committed) before; now it
      // contributes nothing if unlinked, or its whole size if the unlink failed (it is uncommitted bytes now).
      const before = Math.max(0, stat.size - candidate.byteLength);
      let after = 0;
      try {
        fs.unlinkSync(file); // unlink removes the entry itself; it never follows a symlink
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") after = stat.size;
      }
      if (this.leftoverBytes !== null) this.leftoverBytes += after - before;
    }
    return result;
  }
  private metadata(id: string): ImageRef {
    assertImageId(id);
    const ref = this.repos.getImage(id);
    if (!ref) throw new Error("Image is missing; upload again and retry");
    return ref;
  }
  get(id: string): { image: ImageRef; base64: string } {
    const image = this.metadata(id);
    this.checkDirectory();
    let fd: number;
    try {
      fd = fs.openSync(
        path.join(this.directory, id),
        fs.constants.O_RDONLY |
          fs.constants.O_NOFOLLOW |
          fs.constants.O_NONBLOCK,
      );
    } catch {
      throw new Error("Image is unreadable; upload again and retry");
    }
    try {
      const stat = fs.fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.size !== image.byteLength ||
        stat.size > IMAGE_LIMITS.fileBytes
      )
        throw new Error("Image is unreadable; upload again and retry");
      const bytes = Buffer.alloc(image.byteLength);
      let offset = 0;
      while (offset < bytes.length) {
        const n = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (!n) throw new Error("Image is unreadable; upload again and retry");
        offset += n;
      }
      return { image, base64: bytes.toString("base64") };
    } finally {
      fs.closeSync(fd);
    }
  }
  validate(refs: readonly ImageRef[]): ImageRef[] {
    validateImageRefs(refs);
    const result = refs.map((ref) => {
      const image = this.metadata(ref.id);
      if (
        Object.keys(image).some(
          (key) => image[key as keyof ImageRef] !== ref[key as keyof ImageRef],
        )
      )
        throw new Error("Image metadata differs from stored asset; retry");
      // Validate availability before accepting a queued send without retaining decoded/base64 data.
      this.checkDirectory();
      let fd: number;
      try {
        fd = fs.openSync(
          path.join(this.directory, image.id),
          fs.constants.O_RDONLY |
            fs.constants.O_NOFOLLOW |
            fs.constants.O_NONBLOCK,
        );
      } catch {
        throw new Error("Image is unreadable; upload again and retry");
      }
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size !== image.byteLength)
          throw new Error("Image is unreadable; upload again and retry");
      } finally {
        fs.closeSync(fd);
      }
      return image;
    });
    // An accepted send may sit in an in-memory queue before its transcript event persists: restart the GC
    // grace window so a collection in between cannot reclaim it.
    for (const image of result) this.repos.touchImage(image.id);
    return validateImageRefs(result);
  }
  resolve(refs: readonly ImageRef[]): ResolvedImage[] {
    return this.validate(refs).map((ref) => ({
      mediaType: ref.mediaType,
      data: this.get(ref.id).base64,
    }));
  }
}

// Coalesces GC triggers (boot, permanent session/worker deletion) into one deferred run off the request
// path. A failing run is logged, never thrown: GC must not crash boot or a delete.
export class ImageGcScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  constructor(
    private readonly store: Pick<ImageStore, "collectGarbage">,
    private readonly options: { delayMs?: number; log?: (line: string) => void } = {},
  ) {}
  schedule(): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => this.run(), this.options.delayMs ?? 1000);
    this.timer.unref?.();
  }
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
  private run(): void {
    this.timer = undefined;
    const log = this.options.log ?? ((line: string) => process.stderr.write(line));
    try {
      const { deleted, bytes } = this.store.collectGarbage();
      log(`[rookery] image gc: removed ${deleted} unreferenced image(s), ${bytes} bytes\n`);
    } catch (error) {
      log(`[rookery] image gc failed: ${String(error)}\n`);
    }
  }
}
