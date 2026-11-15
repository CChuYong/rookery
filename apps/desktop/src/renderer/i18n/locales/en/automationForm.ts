import type { Catalog } from "../../types.js";
export default {
  "automationForm.eyebrow": "Automation",
  "automationForm.sectionExecution": "Model / Execution",
  "automationForm.provider": "Backend",
  "automationForm.model": "Model",
  "automationForm.effort": "Effort",
  "automationForm.permissionMode": "Permission mode",
  "automationForm.maxTurns": "Max turns",
  "automationForm.maxTurnsHint": "Leave empty for no limit (worker action only).",
  "automationForm.costBudget": "Cost budget (USD)",
  "automationForm.costBudgetHint": "Empty = the default: workers use Settings › General › Worker cost budget; masters have no limit. Applies to both action kinds.",
  "automationForm.bypassWarning": "Bypass Permissions runs every tool without approval in unattended mode. Only use it with trusted triggers.",
  "automationForm.codexBypassWarning": "Codex masters require Bypass Permissions — as set, this automation will fail every run.",
  "automationForm.modelDefaultOption": "Default",
} satisfies Catalog;
