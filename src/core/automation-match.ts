import type { AutomationTrigger } from "../persistence/repositories.js";

export interface SlackEvent { channel: string; userId?: string; text: string }

export function matchesSlack(t: Extract<AutomationTrigger, { kind: "slack" }>, e: SlackEvent): boolean {
  if (t.channels && t.channels.length > 0 && !t.channels.includes(e.channel)) return false;
  if (t.fromUsers && t.fromUsers.length > 0 && !t.fromUsers.includes(e.userId ?? "")) return false;
  if (t.keyword && t.keyword.trim() && !e.text.toLowerCase().includes(t.keyword.toLowerCase())) return false;
  return true;
}
