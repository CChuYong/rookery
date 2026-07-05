import { describe, it, expect } from "vitest";
import fs from "node:fs";

// P0 seam guard: these core modules must stay free of direct Claude SDK imports — provider knowledge
// lives only in claude-backend.ts (adapter), interaction-registry/slack (P2 scope), and src/tools (P2 scope).
const NEUTRAL_FILES = [
  "src/core/worker.ts",
  "src/core/master-agent.ts",
  "src/core/session-manager.ts",
  "src/core/message-queue.ts",
  "src/core/agent-backend.ts",
  "src/core/fleet-orchestrator.ts",
  "src/core/events.ts",
];

describe("provider-neutral core (P0 seam)", () => {
  for (const f of NEUTRAL_FILES) {
    it(`${f} has no direct @anthropic-ai/claude-agent-sdk import`, () => {
      expect(fs.readFileSync(f, "utf8")).not.toMatch(/@anthropic-ai\/claude-agent-sdk/);
    });
  }
});
