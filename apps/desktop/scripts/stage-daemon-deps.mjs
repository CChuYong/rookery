#!/usr/bin/env node
// Stages a node_modules containing only the daemon's prod dependencies.
// Bundling the whole root node_modules would drag in workspace-hoisted desktop/build deps (the full electron .app,
// node-pty, vite, rollup, tailwind, fsevents…), which (1) bloats the bundle to hundreds of MB and
// (2) breaks codesign --deep --strict via dangling/external links like node-pty's external python3 gyp symlink.
// Install only the root package.json dependencies (7 of them) into a clean tree → bundle as daemon-dist/node_modules.
// better-sqlite3 is installed with Node 22 (ABI 127) at build time, so its ABI matches the bundled Node 22.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", ".."); // apps/desktop/scripts → repo root
const STAGE = join(__dirname, "..", "resources", "daemon-deps");

const rootPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const deps = rootPkg.dependencies ?? {};
console.log(`[stage-daemon-deps] prod deps: ${Object.keys(deps).join(", ")}`);

rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });
// A standalone package.json with no workspace fields — npm treats it as standalone.
writeFileSync(
  join(STAGE, "package.json"),
  JSON.stringify({ name: "rookery-daemon-deps", version: rootPkg.version ?? "0.0.0", private: true, dependencies: deps }, null, 2) + "\n",
);

console.log("[stage-daemon-deps] npm install --omit=dev …");
// shell:true so npm resolves to npm.cmd on Windows (execFileSync can't spawn npm directly there). Args are
// static flags (no injection risk). cwd is a separate option, not parsed by the shell.
execFileSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--no-save", "--no-package-lock"], {
  cwd: STAGE,
  stdio: "inherit",
  shell: true,
});

const nm = join(STAGE, "node_modules");
if (!existsSync(join(nm, "better-sqlite3", "build", "Release", "better_sqlite3.node"))) {
  throw new Error("[stage-daemon-deps] better-sqlite3 prebuilt missing after install — check Node 22 / network");
}
console.log(`[stage-daemon-deps] staged → ${nm}`);
