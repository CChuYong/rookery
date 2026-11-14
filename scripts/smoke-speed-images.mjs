#!/usr/bin/env node
// Reuse the boundary regression suites; never connect to a running user daemon.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

if (Number(process.versions.node.split(".")[0]) !== 22) {
  console.error("Use Node 22: better-sqlite3 requires the installed Node 22 ABI.");
  process.exit(1);
}
if (process.argv.length > 2) {
  console.error("Usage: npm run smoke:speed-images (no live-provider mode)");
  process.exit(1);
}
const root = fileURLToPath(new URL("../", import.meta.url));
const vitest = path.join(root, "node_modules/vitest/vitest.mjs");
const phases = [
  {
    name: "daemon-ws-sqlite-and-speed",
    cwd: root,
    files: [
      "test/daemon/image-pipeline.test.ts",
      "test/daemon/desktop-image-acceptance.test.ts",
      "test/daemon/side-image-start.test.ts",
      "test/core/speed.test.ts",
      "test/core/codex/codex-pricing.test.ts",
      "test/core/codex/codex-version.test.ts",
    ],
  },
  {
    name: "desktop-input-speed-and-replay",
    cwd: path.join(root, "apps/desktop"),
    files: [
      "test/composer-images.test.tsx",
      "test/message-images.test.tsx",
      "test/drafts.test.ts",
      "test/store-pending.test.ts",
      "test/composer-speed.test.tsx",
      "test/store-speed.test.ts",
      "test/speed-preference.test.ts",
      "test/metrics-speed.test.tsx",
    ],
  },
];
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|OPENAI_API_KEY|CODEX_API_KEY|SLACK_BOT_TOKEN|SLACK_APP_TOKEN|ROOKERY_CAP_SECRET_.*|ROOKERY_HOME|ROOKERY_PORT)$/.test(key)) delete env[key];
}
for (const phase of phases) {
  console.log(`\nSpeed/images smoke: ${phase.name}`);
  const result = spawnSync(process.execPath, [vitest, "run", ...phase.files], {
    cwd: phase.cwd, env, stdio: "inherit",
  });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log("\nSpeed/images smoke passed. Providers were injected fakes; no live entitlement or rendered UI claim.");
