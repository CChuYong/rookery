import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectSecretRequirements,
  validateCapabilityPack,
} from "../../../src/core/capabilities/manifest.js";

describe("documented capability pack example", () => {
  it("stays valid, safe, and representative of the Slice 2 format", () => {
    const root = path.resolve("docs/examples/capability-pack");
    const pack = validateCapabilityPack(root);

    expect(pack.manifest).toMatchObject({
      schemaVersion: 1,
      id: "rookery-example",
      instructions: [{ id: "team-conventions", path: "instructions/team.md" }],
      skills: [{ id: "review-pr", path: "skills/review-pr" }],
      mcpServers: [{
        id: "knowledge",
        transport: "streamable-http",
        required: false,
      }],
    });
    expect(pack.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(pack.files.map((file) => file.path)).toEqual([
      "capability.json",
      "instructions/team.md",
      "skills/review-pr/SKILL.md",
    ]);
    expect(pack.files.every((file) => !file.executable)).toBe(true);
    expect(collectSecretRequirements(pack.manifest)).toEqual([
      { source: "rookery-secret", key: "knowledge-token" },
    ]);
  });
});
