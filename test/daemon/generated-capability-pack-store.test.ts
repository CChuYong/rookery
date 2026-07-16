import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GeneratedCapabilityPackStore } from "../../src/daemon/generated-capability-pack-store.js";
import type { CapabilityPackManifest } from "../../src/core/capabilities/types.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function manifest(id = "repo-tools"): CapabilityPackManifest {
  return {
    schemaVersion: 1,
    id,
    displayName: "Repo Tools",
    version: "1.0.0",
    description: "Repository MCP servers",
    mcpServers: [
      {
        id: "docs",
        transport: "streamable-http",
        url: "https://example.test/mcp",
        auth: { bearerToken: { source: "rookery-secret", key: "docs-token" } },
      },
    ],
  };
}

function skillManifest(id = "review-skill"): CapabilityPackManifest {
  return {
    schemaVersion: 1,
    id,
    displayName: "Review Skill",
    version: "1.0.0",
    description: "Review repository changes",
    skills: [{ id: "review", path: "skill" }],
  };
}

describe("GeneratedCapabilityPackStore", () => {
  it("atomically creates a validated private manifest without secret values", () => {
    const home = temp("rk-generated-home-");
    const root = path.join(home, "capability-packs");
    const store = new GeneratedCapabilityPackStore(root, { id: () => "one" });

    const created = store.create(manifest());

    expect(created).toBe(path.join(fs.realpathSync.native(root), "repo-tools-one"));
    const file = path.join(created, "capability.json");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(manifest());
    expect(fs.readFileSync(file, "utf8")).not.toContain("secretValues");
    if (process.platform !== "win32") {
      expect(fs.statSync(root).mode & 0o777).toBe(0o700);
      expect(fs.statSync(created).mode & 0o777).toBe(0o700);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
    expect(fs.readdirSync(root)).toEqual(["repo-tools-one"]);
  });

  it("validates before rename, cleans staging on failure, and creates distinct instances", () => {
    const root = path.join(temp("rk-generated-home-"), "capability-packs");
    const ids = ["one", "two"];
    const store = new GeneratedCapabilityPackStore(root, { id: () => ids.shift()! });
    const invalid: CapabilityPackManifest = {
      ...manifest(),
      mcpServers: [
        { id: "one-two", transport: "streamable-http", url: "https://example.test/one" },
        { id: "one_two", transport: "streamable-http", url: "https://example.test/two" },
      ],
    };

    expect(() => store.create(invalid)).toThrow("provider-normalized MCP id collision");
    expect(fs.readdirSync(root)).toEqual([]);

    const first = store.create(manifest());
    const second = store.create(manifest());
    expect(first).not.toBe(second);
    expect(fs.readdirSync(root).sort()).toEqual(["repo-tools-one", "repo-tools-two"]);
  });

  it("imports one Skill directory into a validated private generated pack", () => {
    const home = temp("rk-generated-home-");
    const root = path.join(home, "capability-packs");
    const source = path.join(temp("rk-skill-source-"), "review");
    fs.mkdirSync(path.join(source, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(source, "SKILL.md"), "---\nname: review\ndescription: Review changes\n---\n\nReview carefully.\n");
    fs.writeFileSync(path.join(source, "scripts", "check.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const store = new GeneratedCapabilityPackStore(root, { id: () => "one" });

    const created = store.createSkill(skillManifest(), source);

    expect(created).toBe(path.join(fs.realpathSync.native(root), "review-skill-one"));
    expect(JSON.parse(fs.readFileSync(path.join(created, "capability.json"), "utf8"))).toEqual(skillManifest());
    expect(fs.readFileSync(path.join(created, "skill", "SKILL.md"), "utf8")).toContain("Review carefully.");
    expect(fs.readFileSync(path.join(created, "skill", "scripts", "check.sh"), "utf8")).toContain("exit 0");
    if (process.platform !== "win32") {
      expect(fs.statSync(created).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(created, "skill")).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(created, "capability.json")).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.join(created, "skill", "scripts", "check.sh")).mode & 0o111).not.toBe(0);
    }
    expect(fs.readdirSync(root)).toEqual(["review-skill-one"]);
  });

  it("rejects invalid or escaping Skill imports before rename and cleans staging", () => {
    const root = path.join(temp("rk-generated-home-"), "capability-packs");
    const invalid = path.join(temp("rk-skill-invalid-"), "missing-skill-md");
    fs.mkdirSync(invalid, { recursive: true });
    fs.writeFileSync(path.join(invalid, "README.md"), "not a skill");
    const store = new GeneratedCapabilityPackStore(root, { id: () => "one" });

    expect(() => store.createSkill(skillManifest(), invalid)).toThrow("SKILL.md");
    expect(fs.readdirSync(root)).toEqual([]);

    if (process.platform !== "win32") {
      const source = path.join(temp("rk-skill-escape-"), "skill");
      const outside = path.join(temp("rk-skill-outside-"), "secret.txt");
      fs.mkdirSync(source, { recursive: true });
      fs.writeFileSync(path.join(source, "SKILL.md"), "---\nname: review\ndescription: Review changes\n---\n");
      fs.writeFileSync(outside, "outside");
      fs.symlinkSync(outside, path.join(source, "escape.txt"));

      expect(() => store.createSkill(skillManifest(), source)).toThrow("outside the pack root");
      expect(fs.readdirSync(root)).toEqual([]);
    }
  });

  it("removes only direct generated children and never follows replacement symlinks", () => {
    const home = temp("rk-generated-home-");
    const root = path.join(home, "capability-packs");
    const outside = temp("rk-generated-outside-");
    const marker = path.join(outside, "keep.txt");
    fs.writeFileSync(marker, "keep");
    const store = new GeneratedCapabilityPackStore(root, { id: () => "one" });
    const created = store.create(manifest());

    expect(() => store.remove(outside)).toThrow("direct child");
    expect(() => store.remove(path.join(created, "nested"))).toThrow("direct child");
    expect(fs.existsSync(created)).toBe(true);

    fs.rmSync(created, { recursive: true });
    fs.symlinkSync(outside, created, process.platform === "win32" ? "junction" : "dir");
    store.remove(created);
    expect(fs.existsSync(created)).toBe(false);
    expect(fs.readFileSync(marker, "utf8")).toBe("keep");
  });

  it("removes a generated directory and treats an already missing child as success", () => {
    const root = path.join(temp("rk-generated-home-"), "capability-packs");
    const store = new GeneratedCapabilityPackStore(root, { id: () => "one" });
    const created = store.create(manifest());

    store.remove(created);
    store.remove(created);

    expect(fs.existsSync(created)).toBe(false);
  });
});
