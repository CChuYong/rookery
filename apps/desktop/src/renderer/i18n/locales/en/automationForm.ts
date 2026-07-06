import type { Catalog } from "../../types.js";
export default {
  "automationForm.eyebrow": "Automation",
  "automationForm.sectionExecution": "Model / Execution",
  "automationForm.provider": "Agent backend",
  "automationForm.model": "Model",
  "automationForm.effort": "Effort",
  "automationForm.permissionMode": "Permission mode",
  "automationForm.maxTurns": "Max turns",
  "automationForm.maxTurnsHint": "Leave empty for no limit (worker action only).",
  "automationForm.costBudget": "Cost budget (USD)",
  "automationForm.costBudgetHint": "Empty = use the default (workers fall back to the workerCostBudgetUsd setting; masters have no limit). Applies to both action kinds.",
  "automationForm.bypassWarning": "bypassPermissions runs all tools without approval in unattended mode. Only use with trusted triggers.",
  "automationForm.codexBypassWarning": "Codex sessions require bypassPermissions — this automation will fail every run.",
  "automationForm.modelDefaultOption": "Default",
} satisfies Catalog;
