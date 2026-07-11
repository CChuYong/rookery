// Generates "orbitkit" — a small, dependency-free fictional project used as the demo repo.
// Real enough for workers to genuinely fix (planted bug: changelog month off-by-one; planted
// feature: --json CLI flag), tiny enough that a worker finishes on camera in a few minutes.
//
// Usage: node scripts/demo/make-sample-repo.mjs <target-dir>
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const target = process.argv[2];
if (!target) {
  console.error("usage: node scripts/demo/make-sample-repo.mjs <target-dir>");
  process.exit(1);
}
if (fs.existsSync(path.join(target, ".git"))) {
  console.error(`refusing to overwrite existing git repo at ${target}`);
  process.exit(1);
}

const files = {
  "package.json": JSON.stringify({
    name: "orbitkit",
    version: "0.2.1",
    description: "Tiny static changelog & release-feed generator",
    type: "module",
    bin: { orbitkit: "./src/cli.js" },
    scripts: { test: "node --test test/" },
  }, null, 2) + "\n",

  "README.md": `# orbitkit

Tiny static changelog & release-feed generator. Point it at a \`releases.json\`,
get a rendered changelog page and an RSS-ish feed.

\`\`\`bash
orbitkit build releases.json   # writes changelog.html + feed.xml
\`\`\`

## Roadmap
- [ ] \`--json\` output for CI pipelines
- [ ] theme support
`,

  "releases.json": JSON.stringify([
    { version: "0.2.1", date: "2026-06-30", notes: ["Fix feed escaping for & in titles"] },
    { version: "0.2.0", date: "2026-05-14", notes: ["Feed generation", "CLI: build command"] },
    { version: "0.1.0", date: "2026-04-02", notes: ["Initial release"] },
  ], null, 2) + "\n",

  // Planted bug: getMonth() is zero-based but is rendered as-is, so "2026-06-30" renders as "May 30, 2026"... i18n
  // aside, every date in the changelog shows the previous month. No test covers it (yet) — a worker's job.
  "src/changelog.js": `// Render releases.json into a changelog HTML fragment.
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

export function formatDate(iso) {
  const d = new Date(iso + "T00:00:00Z");
  return \`\${MONTHS[d.getUTCMonth() - 1]} \${d.getUTCDate()}, \${d.getUTCFullYear()}\`;
}

export function renderChangelog(releases) {
  return releases
    .map((r) => \`<section><h2>v\${r.version} — \${formatDate(r.date)}</h2><ul>\${r.notes.map((n) => \`<li>\${escapeHtml(n)}</li>\`).join("")}</ul></section>\`)
    .join("\\n");
}

export function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
`,

  "src/feed.js": `import { escapeHtml } from "./changelog.js";

// Minimal RSS-ish XML feed for release watchers.
export function renderFeed(releases, { title = "orbitkit releases" } = {}) {
  const items = releases
    .map((r) => \`<item><title>\${escapeHtml(\`v\${r.version}\`)}</title><pubDate>\${r.date}</pubDate><description>\${escapeHtml(r.notes.join("; "))}</description></item>\`)
    .join("");
  return \`<?xml version="1.0"?><rss version="2.0"><channel><title>\${escapeHtml(title)}</title>\${items}</channel></rss>\`;
}
`,

  "src/cli.js": `#!/usr/bin/env node
import fs from "node:fs";
import { renderChangelog } from "./changelog.js";
import { renderFeed } from "./feed.js";

// TODO(roadmap): --json flag emitting {changelogHtml, feedXml} for CI pipelines.
const [cmd, file] = process.argv.slice(2);
if (cmd !== "build" || !file) {
  console.error("usage: orbitkit build <releases.json>");
  process.exit(1);
}
const releases = JSON.parse(fs.readFileSync(file, "utf8"));
fs.writeFileSync("changelog.html", renderChangelog(releases));
fs.writeFileSync("feed.xml", renderFeed(releases));
console.log(\`wrote changelog.html + feed.xml (\${releases.length} releases)\`);
`,

  "test/feed.test.js": `import { test } from "node:test";
import assert from "node:assert/strict";
import { renderFeed } from "../src/feed.js";

test("escapes & in titles", () => {
  const xml = renderFeed([{ version: "1.0", date: "2026-01-01", notes: ["a & b"] }]);
  assert.ok(xml.includes("a &amp; b"));
});
`,
};

for (const [rel, content] of Object.entries(files)) {
  const p = path.join(target, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

const git = (...args) => execFileSync("git", args, { cwd: target, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "orbitkit", GIT_AUTHOR_EMAIL: "dev@orbitkit.example", GIT_COMMITTER_NAME: "orbitkit", GIT_COMMITTER_EMAIL: "dev@orbitkit.example" } });
git("init", "-b", "main");
git("add", "-A");
git("commit", "-m", "feat: changelog + feed generation (v0.2.1)");
// A little history so the repo doesn't look single-commit sterile.
fs.appendFileSync(path.join(target, "README.md"), "\n## License\nMIT\n");
git("add", "-A");
git("commit", "-m", "docs: add license note");

console.log(`sample repo ready: ${target}`);
