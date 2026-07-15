import type { CapabilityPreviewTarget, CapabilityTarget } from "@daemon/core/capabilities/types.js";

export function defaultCapabilityPreview(): CapabilityPreviewTarget {
  return { kind: "rookery", provider: "claude", agent: "master" };
}

export function capabilityTargetKey(target: CapabilityTarget): string {
  if (target.kind === "session" || target.kind === "worker") return `${target.kind}:${target.id}`;
  if (target.kind === "repo") return `repo:${target.id}:${target.provider}:${target.agent}`;
  return `rookery:${target.provider}:${target.agent}`;
}

export function capabilityTargetChoice(target: CapabilityTarget): string {
  if (target.kind === "rookery") return "rookery";
  return `${target.kind}:${target.id}`;
}
