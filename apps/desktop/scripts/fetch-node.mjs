#!/usr/bin/env node
// At build time, download the official Node 22 binary for the host platform/arch and bundle it into the app.
// The packaged daemon runs on this Node even if the user's machine has no Node or a mismatched ABI.
// Supply-chain integrity is verified against SHASUMS256 (hash computed via node:crypto — no shasum/sha256sum dependency).
// Idempotent: skip if the same version+arch is already bundled. Built per-platform on a native runner (macOS / Linux / Windows).
import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, rmSync, writeFileSync, readFileSync, copyFileSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

// Pin to the same version as dev/CI Node (every 22.x = ABI 127, so it's compatible with the better-sqlite3 prebuilt).
const NODE_VERSION = process.env.ROOKERY_BUNDLE_NODE_VERSION ?? "22.23.0";
const isWin = process.platform === "win32";
const PLAT = isWin ? "win" : process.platform; // Node release naming: win | darwin | linux
const ARCH = `${PLAT}-${process.arch}`; // darwin-arm64 | linux-x64 | win-x64
const EXT = isWin ? "zip" : "tar.gz";
const NODE_BIN = isWin ? "node.exe" : "node";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEST_DIR = join(__dirname, "..", "resources", "node");
const DEST = join(DEST_DIR, NODE_BIN);
const STAMP = join(DEST_DIR, ".version");
const stampValue = `${NODE_VERSION} ${ARCH}`;

if (existsSync(DEST) && existsSync(join(DEST_DIR, "LICENSE")) && existsSync(STAMP) && readFileSync(STAMP, "utf8").trim() === stampValue) {
  console.log(`[fetch-node] v${NODE_VERSION} (${ARCH}) already bundled → skip`);
  process.exit(0);
}

const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
const dirName = `node-v${NODE_VERSION}-${ARCH}`;
const tarName = `${dirName}.${EXT}`;
const work = join(tmpdir(), `rookery-fetch-node-${NODE_VERSION}-${ARCH}`);
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
if (!want) throw new Error(`[fetch-node] ${tarName} not in SHASUMS256.txt — is v${NODE_VERSION} published for ${ARCH}? bump ROOKERY_BUNDLE_NODE_VERSION.`);
const got = createHash("sha256").update(readFileSync(tarPath)).digest("hex");
if (got !== want) throw new Error(`[fetch-node] checksum mismatch for ${tarName}: got ${got}, want ${want}`);
console.log(`[fetch-node] SHASUMS256 verified (${want.slice(0, 16)}…)`);

// Extract. Windows: PowerShell Expand-Archive — `tar` under bash may resolve to GNU tar, which can't read .zip.
// Unix: tar with cwd=work + relative name. Binary is at <dir>/node.exe (win) or <dir>/bin/node.
if (isWin) {
  execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -LiteralPath '${tarPath}' -DestinationPath '${work}' -Force`], { stdio: "inherit" });
} else {
  execFileSync("tar", ["-xzf", tarName], { stdio: "inherit", cwd: work });
}
const extracted = isWin ? join(work, dirName, "node.exe") : join(work, dirName, "bin", "node");
if (!existsSync(extracted)) throw new Error(`[fetch-node] extracted binary missing at ${extracted}`);

mkdirSync(DEST_DIR, { recursive: true });
copyFileSync(extracted, DEST);
try { chmodSync(DEST, 0o755); } catch { /* no-op on Windows */ }
// Ship Node's own license next to the bundled binary (Node core MIT + V8/OpenSSL/libuv/zlib/ICU notices).
// electron-builder's `resources/node → node` entry then carries it to Contents/Resources/node/LICENSE.
const licenseSrc = join(work, dirName, "LICENSE");
if (!existsSync(licenseSrc)) throw new Error("[fetch-node] LICENSE missing in the Node tarball");
copyFileSync(licenseSrc, join(DEST_DIR, "LICENSE"));
writeFileSync(STAMP, stampValue + "\n");
rmSync(work, { recursive: true, force: true });

const ver = execFileSync(DEST, ["-v"]).toString().trim();
if (ver !== `v${NODE_VERSION}`) throw new Error(`[fetch-node] sanity check failed: bundled reports ${ver}, expected v${NODE_VERSION}`);
console.log(`[fetch-node] bundled ${ver} (${ARCH}) → ${DEST}`);
