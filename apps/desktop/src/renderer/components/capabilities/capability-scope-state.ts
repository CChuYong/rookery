import type { CapabilityBinding, CapabilityQuickBindingMode } from "@daemon/core/capabilities/types.js";

export interface CapabilityScopeState {
  mode: CapabilityQuickBindingMode;
  agents: Array<"master" | "worker">;
  custom: boolean;
}

function sameSet(values: string[], expected: string[]): boolean {
  return values.length === expected.length && expected.every((value) => values.includes(value));
}

export function capabilityScopeState(
  bindings: CapabilityBinding[],
  scopeKind: "rookery" | "repo-local",
  scopeRef: string,
  packInstanceId: string,
): CapabilityScopeState {
  const scoped = bindings.filter((binding) =>
    binding.packInstanceId === packInstanceId
    && binding.scopeKind === scopeKind
    && binding.scopeRef === scopeRef,
  );
  const overlapsQuickAudience = (binding: CapabilityBinding): boolean =>
    binding.audience.origins.includes("ui")
    && binding.audience.agents.some((agent) => agent === "master" || agent === "worker");
  const simple = scoped.filter((binding) =>
    overlapsQuickAudience(binding)
    && sameSet(binding.audience.origins, ["ui"])
    && binding.audience.agents.length > 0
    && binding.audience.agents.every((agent) => agent === "master" || agent === "worker"),
  );
  const custom = scoped.some((binding) => overlapsQuickAudience(binding) && !simple.includes(binding));
  if (custom || (simple.some((binding) => binding.enabled) && simple.some((binding) => !binding.enabled))) {
    return { mode: "inherit", agents: [], custom: true };
  }
  if (simple.length === 0) return { mode: "inherit", agents: ["master", "worker"], custom: false };
  const agents = (["master", "worker"] as const).filter((agent) =>
    simple.some((binding) => binding.audience.agents.includes(agent)));
  return { mode: simple[0]!.enabled ? "enabled" : "disabled", agents, custom: false };
}

export function repositoryCapabilityInheritance(
  bindings: CapabilityBinding[],
  packInstanceId: string,
): CapabilityScopeState {
  return capabilityScopeState(bindings, "rookery", "", packInstanceId);
}
