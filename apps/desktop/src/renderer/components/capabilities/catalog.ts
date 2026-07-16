import type { CapabilityLibraryEntry } from "@daemon/core/capabilities/types.js";

export type CapabilityCatalogKind = "mcp" | "skill" | "bundle";

export function catalogKind(pack: CapabilityLibraryEntry): CapabilityCatalogKind {
  const instructions = pack.manifest.instructions?.length ?? 0;
  const skills = pack.manifest.skills?.length ?? 0;
  const mcpServers = pack.manifest.mcpServers?.length ?? 0;
  if (instructions === 0 && skills === 0 && mcpServers === 1) return "mcp";
  if (instructions === 0 && skills === 1 && mcpServers === 0) return "skill";
  return "bundle";
}

export function catalogSearchText(pack: CapabilityLibraryEntry): string {
  return [
    pack.manifest.displayName,
    pack.manifest.id,
    pack.manifest.description,
    ...(pack.manifest.skills ?? []).map((skill) => skill.id),
    ...(pack.manifest.mcpServers ?? []).map((server) => server.id),
  ].join(" ").toLocaleLowerCase();
}
