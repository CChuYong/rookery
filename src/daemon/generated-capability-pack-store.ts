import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { validateCapabilityPack } from "../core/capabilities/manifest.js";
import type { CapabilityPackManifest } from "../core/capabilities/types.js";

export interface GeneratedCapabilityPackStoreOptions {
  id?: () => string;
}

export class GeneratedCapabilityPackStore {
  private readonly root: string;
  private readonly id: () => string;

  constructor(root: string, options: GeneratedCapabilityPackStoreOptions = {}) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.chmodSync(root, 0o700);
    this.root = fs.realpathSync.native(root);
    this.id = options.id ?? randomUUID;
  }

  create(manifest: CapabilityPackManifest): string {
    const staging = fs.mkdtempSync(path.join(this.root, ".staging-"));
    try {
      fs.chmodSync(staging, 0o700);
      const manifestPath = path.join(staging, "capability.json");
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      fs.chmodSync(manifestPath, 0o600);
      validateCapabilityPack(staging);

      const instanceToken = this.id();
      if (!/^[A-Za-z0-9_-]+$/.test(instanceToken)) {
        throw new Error("generated capability pack id must contain only letters, numbers, underscores, or hyphens");
      }
      const destination = path.join(this.root, `${manifest.id}-${instanceToken}`);
      if (path.dirname(destination) !== this.root) {
        throw new Error("generated capability pack destination must be a direct child");
      }
      fs.renameSync(staging, destination);
      return destination;
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }

  remove(sourcePath: string): void {
    const candidate = path.resolve(sourcePath);
    if (candidate === this.root || path.dirname(candidate) !== this.root) {
      throw new Error("generated capability pack path must be a direct child of the generated root");
    }

    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      fs.unlinkSync(candidate);
      return;
    }
    fs.rmSync(candidate, { recursive: true });
  }
}
