// Fixture-directory guard for the synthetic image smoke server: the server writes a throwaway home,
// so it must only ever run under a temporary directory. Compare REAL paths — on macOS /tmp and
// os.tmpdir() (/var/folders/...) are symlinks into /private, so a realpath'd fixture dir such as
// /private/tmp/... must be accepted, and a symlink that escapes the temp roots must not pass.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// realpath of the longest existing prefix, with the not-yet-created remainder appended verbatim.
function realish(p) {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync(abs);
  } catch {
    const parent = path.dirname(abs);
    return parent === abs ? abs : path.join(realish(parent), path.basename(abs));
  }
}

export function assertTemporaryFixtureDir(dir, tmpRoots = [os.tmpdir(), "/tmp"]) {
  const resolved = realish(dir);
  const roots = new Set(tmpRoots.flatMap((root) => [path.resolve(root), realish(root)]));
  for (const root of roots) if (resolved.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) return resolved;
  throw Error("Fixture directory must be under a temporary directory");
}
