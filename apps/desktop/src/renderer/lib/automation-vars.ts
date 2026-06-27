// For the manual-run dialog: pick out only the template vars referenced by the action text.
// ⚠️ Must match the token set of the core applyVars (src/core/automation-action.ts) — when adding a var there, update here too.
export const KNOWN_AUTOMATION_VARS = ["message", "channel", "user", "ts", "threadTs", "team"] as const;
const KNOWN = new Set<string>(KNOWN_AUTOMATION_VARS);

export function referencedVars(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/\{\{(\w+)\}\}/g)) {
    const name = m[1];
    if (KNOWN.has(name) && !seen.has(name)) { seen.add(name); out.push(name); }
  }
  return out;
}
