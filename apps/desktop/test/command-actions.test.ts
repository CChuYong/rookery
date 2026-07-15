import { describe, expect, it } from "vitest";
import type { CommandCandidate } from "@daemon/core/capabilities/commands.js";
import { capabilityCenterRoute, localizeCommandCandidates } from "../src/renderer/lib/command-actions.js";

describe("command actions", () => {
  it("lowers Capability Center actions into exact UI routes", () => {
    expect(capabilityCenterRoute({ type: "open-capability-center", kind: "mcp" })).toEqual({ tab: "effective", kind: "mcp" });
    expect(capabilityCenterRoute({ type: "open-capability-center", tab: "assignments" })).toEqual({ tab: "assignments" });
    expect(capabilityCenterRoute({ type: "open-panel", panel: "side" })).toBeNull();
  });

  it("localizes Rookery commands without rewriting provider candidates", () => {
    const commands: CommandCandidate[] = [
      { id: "rookery.command.skills", name: "skills", description: "server", action: { type: "open-capability-center", kind: "skill" } },
      { id: "rookery.command.side", name: "side", description: "server", argumentHint: "<question>", action: { type: "open-panel", panel: "side" } },
      { id: "provider.skill.review", name: "review", description: "Provider description", action: { type: "insert-prompt", text: "$review" } },
    ];
    const localized = localizeCommandCandidates(commands, (key) => `translated:${key}`);

    expect(localized[0]?.description).toBe("translated:composer.commandSkillsDescription");
    expect(localized[1]?.argumentHint).toBe("translated:sideConversation.commandArgumentHint");
    expect(localized[2]).toBe(commands[2]);
  });
});
