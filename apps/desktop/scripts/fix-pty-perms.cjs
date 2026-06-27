// node-pty 1.1.0's N-API prebuild loads without a rebuild on both Electron (ABI 128) and Node 22.
// However, when npm unpacks the prebuild it loses the +x bit on the spawn-helper executable, so pty.fork
// dies with "posix_spawnp failed". Restore execute permission on spawn-helper after install (postinstall).
const fs = require("node:fs");
const path = require("node:path");

let dir;
try {
  dir = path.dirname(require.resolve("node-pty/package.json"));
} catch {
  console.log("[fix-pty-perms] node-pty not installed — skipping");
  process.exit(0);
}
const prebuilds = path.join(dir, "prebuilds");
if (!fs.existsSync(prebuilds)) process.exit(0);
for (const platform of fs.readdirSync(prebuilds)) {
  const helper = path.join(prebuilds, platform, "spawn-helper");
  if (fs.existsSync(helper)) {
    try {
      fs.chmodSync(helper, 0o755);
      console.log(`[fix-pty-perms] chmod +x ${helper}`);
    } catch (e) {
      console.error(`[fix-pty-perms] ${helper}: ${e.message}`);
    }
  }
}
