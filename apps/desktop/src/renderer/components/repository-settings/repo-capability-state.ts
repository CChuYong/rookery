import type { CapabilityBinding } from "@daemon/core/capabilities/types.js";
import { capabilityScopeState, type CapabilityScopeState } from "../capabilities/capability-scope-state.js";

export type RepositoryCapabilityState = CapabilityScopeState;

export function repositoryCapabilityState(
  bindings: CapabilityBinding[],
  repoId: string,
  packInstanceId: string,
): RepositoryCapabilityState {
  return capabilityScopeState(bindings, "repo-local", repoId, packInstanceId);
}
