import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_CAPABILITY_PACK_BYTES,
  MAX_CAPABILITY_PACK_FILES,
  CapabilityPackValidationError,
  collectSecretRequirements,
  validateCapabilityPack,
} from "../../../src/core/capabilities/manifest.js";
import type { CapabilityPackManifest } from "../../../src/core/capabilities/types.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rookery-cap-pack-"));
  roots.push(root);
  return root;
}

function validManifest(): CapabilityPackManifest {
  return {
    schemaVersion: 1,
    id: "team-engineering",
    displayName: "Team Engineering",
    version: "1.2.0",
    description: "Shared review workflows",
    instructions: [{ id: "engineering-guidance", path: "instructions/engineering.md" }],
    skills: [{ id: "review-pr", path: "skills/review-pr" }],
    mcpServers: [
      {
        id: "local-search",
        transport: "stdio",
        command: "node",
        args: ["scripts/search.mjs"],
        cwd: ".",
        env: { PUBLIC_MODE: "readonly" },
        secretEnv: { GITHUB_TOKEN: { source: "environment", name: "GITHUB_TOKEN" } },
      },
      {
        id: "sentry",
        transport: "streamable-http",
        url: "https://mcp.example.com/sentry",
        headers: { "x-client": "rookery" },
        secretHeaders: { "x-api-key": { source: "rookery-secret", key: "sentry-token" } },
        auth: { bearerToken: { source: "rookery-secret", key: "sentry-token" } },
        enabledTools: ["read_issue", "search_issues"],
      },
    ],
  };
}

function writePack(manifest: CapabilityPackManifest = validManifest()): string {
  const root = tempRoot();
  fs.mkdirSync(path.join(root, "instructions"), { recursive: true });
  fs.mkdirSync(path.join(root, "skills/review-pr/scripts"), { recursive: true });
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "capability.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(root, "instructions/engineering.md"), "# Engineering\n\nReview before shipping.\n");
  fs.writeFileSync(path.join(root, "skills/review-pr/SKILL.md"), [
    "---",
    "name: review-pr",
    "description: >",
    "  Review pull requests",
    "  safely.",
    "---",
    "",
    "Review the current diff.",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(root, "skills/review-pr/scripts/check.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(root, "scripts/search.mjs"), "console.log('search');\n");
  return root;
}

function expectValidationError(fn: () => unknown, pattern: RegExp): void {
  try {
    fn();
    throw new Error("expected validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(CapabilityPackValidationError);
    expect((error as Error).message).toMatch(pattern);
  }
}

describe("validateCapabilityPack", () => {
  it("normalizes a valid pack, inventories safe file metadata, and returns a deterministic digest", () => {
    const root = writePack();

    const first = validateCapabilityPack(root);
    const second = validateCapabilityPack(root);

    expect(first.root).toBe(fs.realpathSync.native(root));
    expect(first.manifest.id).toBe("team-engineering");
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(second.digest).toBe(first.digest);
    expect(first.files.map((file) => file.path)).toEqual([
      "capability.json",
      "instructions/engineering.md",
      "scripts/search.mjs",
      "skills/review-pr/SKILL.md",
      "skills/review-pr/scripts/check.sh",
    ]);
    expect(first.files.find((file) => file.path.endsWith("check.sh"))).toMatchObject({
      executable: true,
      mode: 0o755,
    });
    expect(first.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true);
  });

  it("changes the digest when instruction or executable content changes", () => {
    const root = writePack();
    const before = validateCapabilityPack(root).digest;
    fs.appendFileSync(path.join(root, "instructions/engineering.md"), "Changed.\n");
    const afterInstruction = validateCapabilityPack(root).digest;
    fs.appendFileSync(path.join(root, "skills/review-pr/scripts/check.sh"), "echo changed\n");
    const afterScript = validateCapabilityPack(root).digest;

    expect(afterInstruction).not.toBe(before);
    expect(afterScript).not.toBe(afterInstruction);
  });

  it("deduplicates and sorts secret requirements without reading values", () => {
    const requirements = collectSecretRequirements(validManifest());
    expect(requirements).toEqual([
      { source: "environment", key: "GITHUB_TOKEN" },
      { source: "rookery-secret", key: "sentry-token" },
    ]);
    expect(JSON.stringify(requirements)).not.toContain("readonly");
  });

  it("rejects unsupported schema versions and invalid ids", () => {
    const root = writePack();
    const manifest = { ...validManifest(), schemaVersion: 2, id: "Bad ID" };
    fs.writeFileSync(path.join(root, "capability.json"), JSON.stringify(manifest));
    expectValidationError(() => validateCapabilityPack(root), /schemaVersion|id/i);
  });

  it("rejects provider-normalized MCP id collisions", () => {
    const manifest = validManifest();
    manifest.mcpServers = [
      { id: "a-b", transport: "stdio", command: "one" },
      { id: "a_b", transport: "stdio", command: "two" },
    ];
    const root = writePack(manifest);
    expectValidationError(() => validateCapabilityPack(root), /normalized.*collision/i);
  });

  it("rejects absolute paths, traversal, missing files, and mismatched skill names", () => {
    const absolute = validManifest();
    absolute.instructions = [{ id: "bad", path: "/tmp/outside.md" }];
    expectValidationError(() => validateCapabilityPack(writePack(absolute)), /relative|inside/i);

    const traversal = validManifest();
    traversal.instructions = [{ id: "bad", path: "../outside.md" }];
    expectValidationError(() => validateCapabilityPack(writePack(traversal)), /relative|inside|\.\./i);

    const missingRoot = writePack();
    fs.unlinkSync(path.join(missingRoot, "instructions/engineering.md"));
    expectValidationError(() => validateCapabilityPack(missingRoot), /instruction.*does not exist/i);

    const mismatchRoot = writePack();
    fs.writeFileSync(path.join(mismatchRoot, "skills/review-pr/SKILL.md"), "---\nname: other\ndescription: Review safely\n---\n");
    expectValidationError(() => validateCapabilityPack(mismatchRoot), /must equal.*review-pr|review-pr.*must equal/i);
  });

  it("rejects malformed or incomplete SKILL frontmatter", () => {
    const missingDescription = writePack();
    fs.writeFileSync(path.join(missingDescription, "skills/review-pr/SKILL.md"), "---\nname: review-pr\n---\n");
    expectValidationError(() => validateCapabilityPack(missingDescription), /description/i);

    const unterminated = writePack();
    fs.writeFileSync(path.join(unterminated, "skills/review-pr/SKILL.md"), "---\nname: review-pr\ndescription: Broken\n");
    expectValidationError(() => validateCapabilityPack(unterminated), /frontmatter/i);
  });

  it("rejects symlink escapes and cycles while allowing contained files", () => {
    const outside = tempRoot();
    fs.writeFileSync(path.join(outside, "secret.md"), "outside\n");
    const escapeRoot = writePack();
    fs.symlinkSync(path.join(outside, "secret.md"), path.join(escapeRoot, "escaped.md"));
    expectValidationError(() => validateCapabilityPack(escapeRoot), /symlink.*outside|escapes.*root/i);

    const cycleRoot = writePack();
    fs.symlinkSync(cycleRoot, path.join(cycleRoot, "loop"));
    expectValidationError(() => validateCapabilityPack(cycleRoot), /cycle/i);

    const containedRoot = writePack();
    fs.symlinkSync("engineering.md", path.join(containedRoot, "instructions/alias.md"));
    expect(validateCapabilityPack(containedRoot).files.map((file) => file.path)).toContain("instructions/alias.md");
  });

  it("rejects literal credential-like environment and header keys", () => {
    const envManifest = validManifest();
    envManifest.mcpServers = [{ id: "bad", transport: "stdio", command: "node", env: { API_TOKEN: "plaintext" } }];
    expectValidationError(() => validateCapabilityPack(writePack(envManifest)), /API_TOKEN.*secretEnv|credential/i);

    const headerManifest = validManifest();
    headerManifest.mcpServers = [{ id: "bad", transport: "streamable-http", url: "https://example.test", headers: { Authorization: "Bearer plaintext" } }];
    expectValidationError(() => validateCapabilityPack(writePack(headerManifest)), /Authorization.*secretHeaders|credential/i);
  });

  it("rejects non-HTTP URLs and out-of-range timeouts", () => {
    const urlManifest = validManifest();
    urlManifest.mcpServers = [{ id: "bad", transport: "streamable-http", url: "file:///tmp/socket" }];
    expectValidationError(() => validateCapabilityPack(writePack(urlManifest)), /http|url/i);

    const timeoutManifest = validManifest();
    timeoutManifest.mcpServers = [{ id: "bad", transport: "stdio", command: "node", startupTimeoutSec: 0, toolTimeoutSec: 601 }];
    expectValidationError(() => validateCapabilityPack(writePack(timeoutManifest)), /startupTimeoutSec|toolTimeoutSec/i);
  });

  it("enforces the exact default traversal limits and injectable lower limits", () => {
    expect(MAX_CAPABILITY_PACK_FILES).toBe(2_000);
    expect(MAX_CAPABILITY_PACK_BYTES).toBe(64 * 1024 * 1024);

    const fileRoot = writePack();
    expectValidationError(
      () => validateCapabilityPack(fileRoot, { maxFiles: 4, maxBytes: MAX_CAPABILITY_PACK_BYTES }),
      /more than 4 files/i,
    );

    const byteRoot = writePack();
    expectValidationError(
      () => validateCapabilityPack(byteRoot, { maxFiles: MAX_CAPABILITY_PACK_FILES, maxBytes: 32 }),
      /more than 32 bytes/i,
    );
  });
});
