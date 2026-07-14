import type { CapabilityKind } from "@daemon/core/capabilities/types.js";
import type { CommandAction, CommandCandidate } from "@daemon/core/capabilities/commands.js";

export interface CapabilityCenterRoute {
  tab: "effective" | "library" | "assignments";
  kind?: CapabilityKind;
}

export function capabilityCenterRoute(action: CommandAction): CapabilityCenterRoute | null {
  if (action.type !== "open-capability-center") return null;
  return {
    tab: action.tab ?? "effective",
    ...(action.kind ? { kind: action.kind } : {}),
  };
}

const DESCRIPTION_KEYS: Record<string, string> = {
  "rookery.command.btw": "sideConversation.commandDescription",
  "rookery.command.capabilities": "composer.commandCapabilitiesDescription",
  "rookery.command.hooks": "composer.commandHooksDescription",
  "rookery.command.mcp": "composer.commandMcpDescription",
  "rookery.command.side": "sideConversation.commandDescription",
  "rookery.command.skills": "composer.commandSkillsDescription",
};

export function localizeCommandCandidates(commands: CommandCandidate[], t: (key: string) => string): CommandCandidate[] {
  return commands.map((command) => {
    const descriptionKey = DESCRIPTION_KEYS[command.id];
    if (!descriptionKey) return command;
    const sideCommand = command.id === "rookery.command.btw" || command.id === "rookery.command.side";
    return {
      ...command,
      description: t(descriptionKey),
      ...(sideCommand ? { argumentHint: t("sideConversation.commandArgumentHint") } : {}),
    };
  });
}
