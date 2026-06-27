#!/usr/bin/env node
// At build time, download the official Node 22 arm64 binary and bundle it into the app (a signing/notarization target).
// The packaged daemon runs on this Node even if the user's machine has no Node or a mismatched ABI. Supply-chain integrity is verified via SHASUMS256.
// Idempotent: skip if the same version is already downloaded. mac-only build, so it relies on curl/shasum/tar (system-provided).
import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, rmSync, writeFileSync, readFileSync, copyFileSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

// Pin to the same version as dev/CI Node (every 22.x = ABI 127, so it's compatible with the better-sqlite3 prebuilt).
const NODE_VERSION = process.env.ROOKERY_BUNDLE_NODE_VERSION ?? "22.23.0";
const ARCH = "darwin-arm64";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEST_DIR = join(__dirname, "..", "resources", "node");
const DEST = join(DEST_DIR, "node");
const STAMP = join(DEST_DIR, ".version");

if (existsSync(DEST) && existsSync(STAMP) && existsSync(join(DEST_DIR, "LICENSE")) && readFileSync(STAMP, "utf8").trim() === NODE_VERSION) {
  console.log(`[fetch-node] v${NODE_VERSION} (${ARCH}) already bundled → skip`);
  process.exit(0);
}

const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
const tarName = `node-v${NODE_VERSION}-${ARCH}.tar.gz`;
const work = join(tmpdir(), `rookery-fetch-node-${NODE_VERSION}`);
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const tarPath = join(work, tarName);
const sumsPath = join(work, "SHASUMS256.txt");

console.log(`[fetch-node] downloading ${tarName} …`);
execFileSync("curl", ["-fsSL", `${base}/${tarName}`, "-o", tarPath], { stdio: "inherit" });
execFileSync("curl", ["-fsSL", `${base}/SHASUMS256.txt`, "-o", sumsPath], { stdio: "inherit" });

const want = readFileSync(sumsPath, "utf8")
  .split("\n")
  .find((l) => l.trim().endsWith(`  ${tarName}`))
  ?.trim()
  .split(/\s+/)[0];
if (!want) throw new Error(`[fetch-node] ${tarName} not in SHASUMS256.txt — is v${NODE_VERSION} published? bump ROOKERY_BUNDLE_NODE_VERSION.`);
const got = execFileSync("shasum", ["-a", "256", tarPath]).toString().trim().split(/\s+/)[0];
if (got !== want) throw new Error(`[fetch-node] checksum mismatch for ${tarName}: got ${got}, want ${want}`);
console.log(`[fetch-node] SHASUMS256 verified (${want.slice(0, 16)}…)`);

execFileSync("tar", ["-xzf", tarPath, "-C", work], { stdio: "inherit" });
const extracted = join(work, `node-v${NODE_VERSION}-${ARCH}`, "bin", "node");
if (!existsSync(extracted)) throw new Error(`[fetch-node] extracted binary missing at ${extracted}`);

mkdirSync(DEST_DIR, { recursive: true });
copyFileSync(extracted, DEST);
chmodSync(DEST, 0o755);
// Ship Node's own license next to the bundled binary (Node core MIT + V8/OpenSSL/libuv/zlib/ICU notices).
// electron-builder's `resources/node → node` entry then carries it to Contents/Resources/node/LICENSE.
const licenseSrc = join(work, `node-v${NODE_VERSION}-${ARCH}`, "LICENSE");
if (!existsSync(licenseSrc)) throw new Error("[fetch-node] LICENSE missing in the Node tarball");
copyFileSync(licenseSrc, join(DEST_DIR, "LICENSE"));
writeFileSync(STAMP, NODE_VERSION + "\n");
rmSync(work, { recursive: true, force: true });

const ver = execFileSync(DEST, ["-v"]).toString().trim();
if (ver !== `v${NODE_VERSION}`) throw new Error(`[fetch-node] sanity check failed: bundled reports ${ver}, expected v${NODE_VERSION}`);
console.log(`[fetch-node] bundled ${ver} → ${DEST}`);
