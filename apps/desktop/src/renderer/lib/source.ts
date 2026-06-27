import type { SourceItem } from "@daemon/core/source-intake.js";

// Selected issue/ticket → agent task message (structured block) + label. Same for both providers.
export function buildSourceTask(item: SourceItem): { task: string; label: string } {
  const head = `## ${item.identifier}: ${item.title}\n${item.url}`;
  return {
    task: item.body ? `${head}\n\n${item.body}` : head,
    label: `${item.identifier} ${item.title}`.slice(0, 60),
  };
}
