import { useState } from "react";
import { X } from "lucide-react";
import type { Automation, AutomationInput, AutomationTrigger, AutomationAction } from "@daemon/persistence/repositories.js";
import { useT } from "../i18n/provider.js";
import { Button } from "../ui/button.js";
import { Input, Select } from "../ui/input.js";
import { PromptEditor } from "./PromptEditor.js";
import type { SlashCommand } from "./PromptEditor.js";
import type { BrowseResult } from "../types/rookery.js";
import { PERMISSION_MODES, permLabel } from "./Composer.js";
import { EFFORTS, codexDefaultEffort, codexEffortsFor, effortLabelKey, effortSupported } from "../lib/models.js";
import { useStore } from "../store/store.js";

// Comma-separated id string ↔ array. Drops empty tokens, and returns undefined when empty (= no filter).
const parseIds = (s: string): string[] | undefined => {
  const ids = s.split(",").map((x) => x.trim()).filter(Boolean);
  return ids.length ? ids : undefined;
};
const joinIds = (ids?: string[]): string => (ids ?? []).join(", ");

// permissionMode options exposed only for the worker action (bypass + plan only)
const WORKER_PERMISSION_MODES = ["bypassPermissions", "plan"] as const;

export function AutomationForm(p: {
  job: Automation | "new";
  repos: { name: string; path: string }[];
  commands?: SlashCommand[];
  browseDir?: (dir: string, base?: string) => Promise<BrowseResult>;
  onClose: () => void;
  onSubmit: (input: AutomationInput) => Promise<void>;
}): JSX.Element {
  const t = useT();
  const models = useStore((s) => s.models); // live model list (static fallback when absent)
  const codexModels = useStore((s) => s.codexModels); // codex catalog from codex.models.list; null = couldn't fetch → free-text-tolerant select fallback
  const init = p.job === "new" ? null : p.job;
  const [name, setName] = useState(init?.name ?? "");
  // UI edits only cron/slack ('once' is for the agent's own wake-up, so it's excluded from the list → cron fallback)
  const [triggerKind, setTriggerKind] = useState<"cron" | "slack">(init && init.trigger.kind === "slack" ? "slack" : "cron");
  const [actionKind, setActionKind] = useState<"master" | "worker">(init?.action.kind ?? "master");
  const [enabled, setEnabled] = useState(init?.enabled ?? false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // cron trigger fields
  const ct = init && init.trigger.kind === "cron" ? init.trigger : null;
  const [cron, setCron] = useState(ct?.cron ?? "0 3 * * *");
  const [tz, setTz] = useState(ct?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);

  // slack trigger fields
  const st = init && init.trigger.kind === "slack" ? init.trigger : null;
  const [channels, setChannels] = useState(joinIds(st?.channels));
  const [keyword, setKeyword] = useState(st?.keyword ?? "");
  const [fromUsers, setFromUsers] = useState(joinIds(st?.fromUsers));

  // master action fields
  const mc = init && init.action.kind === "master" ? init.action : null;
  const [prompt, setPrompt] = useState(mc?.prompt ?? "");
  const [cwd, setCwd] = useState(mc?.cwd ?? "");
  const [sessionMode, setSessionMode] = useState<"reuse" | "fresh">(mc?.sessionMode ?? "reuse");

  // worker action fields
  const wc = init && init.action.kind === "worker" ? init.action : null;
  const [repo, setRepo] = useState(wc?.repo ?? (p.repos[0]?.name ?? ""));
  const [task, setTask] = useState(wc?.task ?? "");
  const [base, setBase] = useState(wc?.base ?? "");

  // Agent backend for this automation's created sessions/workers (Task 3: P3 automation-origin codex).
  // Applies to BOTH master and worker actions, so it lives in the shared Model/Execution section below
  // rather than inside the per-kind action block. Mirrors WorkerSpawnModal's provider idiom.
  const [provider, setProvider] = useState<"claude" | "codex">(init?.provider === "codex" ? "codex" : "claude");

  // Model / Execution fields (Task 4: newly added)
  const [model, setModel] = useState(init?.model ?? "");
  const [effort, setEffort] = useState(init?.effort ?? "high");
  // Defaults to bypassPermissions (common to all triggers; existing items fall back to the saved value or bypassPermissions)
  const [permissionMode, setPermissionMode] = useState(init?.permissionMode ?? "bypassPermissions");
  // maxTurns is managed as a string (empty = unset)
  const [maxTurns, setMaxTurns] = useState(init?.maxTurns != null ? String(init.maxTurns) : "");
  // costBudgetUsd (cost budget guard Task 3) — a string, empty = unset. Unlike maxTurns, this applies to
  // BOTH master and worker actions (the daemon checks it at runTurn WARN for master / fleet.spawn STOP for worker).
  const [costBudget, setCostBudget] = useState(init?.costBudgetUsd != null ? String(init.costBudgetUsd) : "");

  // Create/update is a real round-trip (the server validates cron) → reflect the saving state on Save (otherwise the user clicks twice)
  const [saving, setSaving] = useState(false);

  // Codex model/effort catalog coupling (Task 4) — mirrors WorkerSpawnModal/NewSessionPage's derived-consts idiom.
  // `codexModels` present (non-null) AND provider is codex → the model select sources from the catalog and the
  // effort select is driven by the selected model's supportedEfforts (falling back to the generic EFFORTS
  // vocabulary when the model is unknown to the catalog, e.g. an out-of-list saved override).
  const isCodexList = provider === "codex" && codexModels != null;
  const codexEfforts = isCodexList ? codexEffortsFor(model, codexModels) : null;
  const effortOptions: readonly string[] = codexEfforts && codexEfforts.length > 0 ? codexEfforts : EFFORTS;
  // "effort-supported" gate: for codex+list a model is always effort-supported (catalog value or the EFFORTS
  // fallback is never empty); otherwise fall back to the generic Claude-oriented check (hides only for haiku).
  const modelEffortSupported = (m: string): boolean => (isCodexList ? true : effortSupported(m));

  const submit = async () => {
    setSubmitError(null);
    const ch = parseIds(channels);
    const fu = parseIds(fromUsers);
    const trigger: AutomationTrigger =
      triggerKind === "cron"
        ? { kind: "cron", cron: cron.trim(), timezone: tz.trim() }
        : {
            kind: "slack",
            ...(ch ? { channels: ch } : {}),
            ...(keyword.trim() ? { keyword: keyword.trim() } : {}),
            ...(fu ? { fromUsers: fu } : {}),
          };
    const action: AutomationAction =
      actionKind === "master"
        ? { kind: "master", prompt, cwd, sessionMode }
        : { kind: "worker", repo, task, ...(base.trim() ? { base: base.trim() } : {}) };

    // spec C.5: assemble model/effort/permissionMode/maxTurns
    const resolvedModel = model || null;
    const resolvedEffort = resolvedModel && modelEffortSupported(resolvedModel) ? effort : null;
    const resolvedPermissionMode = permissionMode || null;
    // maxTurns: an integer valid only for the worker action; master is always null
    const resolvedMaxTurns = actionKind === "worker" && maxTurns.trim() ? parseInt(maxTurns, 10) : null;
    // costBudgetUsd: applies to BOTH action kinds — no worker-only guard (mirror the null-when-empty shape).
    const resolvedCostBudget = costBudget.trim() && Number.isFinite(Number(costBudget)) && Number(costBudget) > 0 ? Number(costBudget) : null;

    setSaving(true);
    try {
      await p.onSubmit({
        name: name.trim(),
        trigger,
        action,
        enabled,
        provider,
        model: resolvedModel,
        effort: resolvedEffort,
        permissionMode: resolvedPermissionMode,
        maxTurns: resolvedMaxTurns,
        costBudgetUsd: resolvedCostBudget,
      });
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : t("automationModal.invalidCron"));
    } finally {
      setSaving(false);
    }
  };

  const pickCwd = async () => {
    const d = await window.rookery.pickDirectory();
    if (d) setCwd(d);
  };

  const triggerValid = triggerKind === "cron" ? cron.trim().split(/\s+/).length >= 5 : true;
  const actionValid = actionKind === "master" ? prompt.trim() && cwd.trim() : repo && task.trim();
  const valid = name.trim() && triggerValid && actionValid;

  // repo path for the worker action (basis for @ file autocomplete)
  const repoPath = p.repos.find((r) => r.name === repo)?.path;

  // permissionMode options: worker = bypass+plan only, master = all 4
  const permModes = actionKind === "worker" ? WORKER_PERMISSION_MODES : PERMISSION_MODES;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Header bar — matches the overlay-header pattern shared by SettingsPage/AutomationPage/NewSessionPage
          (drag h-11 px-5 + mono eyebrow + lucide X close); Cancel/Save moved to a body-bottom footer, mirroring
          SettingsPage's Save placement (audit #75). */}
      <div className="drag flex h-11 shrink-0 items-center gap-2 border-b border-line px-5 text-[13px]">
        <span className="eyebrow shrink-0 select-none font-mono text-[9px] uppercase tracking-[0.16em] text-muted/60">
          {t("automationForm.eyebrow")}
        </span>
        <span className="font-semibold tracking-[-0.01em]">
          {p.job === "new" ? t("automationModal.titleNew") : t("automationModal.titleEdit")}
        </span>
        <button
          type="button"
          onClick={p.onClose}
          aria-label={t("common.close")}
          className="no-drag ml-auto rounded-md p-1.5 text-muted transition-colors hover:bg-raised hover:text-fg-dim"
        >
          <X size={16} />
        </button>
      </div>

      {/* Inline submit error (audit #4) — shown right under the header so a failed save (e.g. invalid cron) is
          visible without scrolling the body. */}
      {submitError && (
        <p className="shrink-0 border-b border-line bg-fail/12 px-4 py-2 text-[12px] text-fail">{submitError}</p>
      )}

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-6 py-5 flex flex-col gap-5">

          {/* ── Basic section */}
          <section className="flex flex-col gap-3">
            <h3 className="eyebrow eyebrow-sm font-semibold uppercase text-fg-dim">{t("automationModal.sectionBasic")}</h3>
            <label className="flex flex-col gap-1">
              <span className="text-[12px] text-fg-dim">{t("automationModal.name")}</span>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="accent-accent"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              <span className="text-[12px] text-fg-dim">{t("automationModal.enabled")}</span>
            </label>
          </section>

          {/* ── Trigger section */}
          <section className="flex flex-col gap-3">
            <h3 className="eyebrow eyebrow-sm font-semibold uppercase text-fg-dim">{t("automationModal.sectionTrigger")}</h3>

            <label className="flex flex-col gap-1">
              <span className="text-[12px] text-fg-dim">{t("automationModal.triggerType")}</span>
              <Select
                size="md"
                className="w-full"
                value={triggerKind}
                onChange={(e) => setTriggerKind(e.target.value as "cron" | "slack")}
              >
                <option value="cron">{t("automationModal.triggerCron")}</option>
                <option value="slack">{t("automationModal.triggerSlack")}</option>
              </Select>
            </label>

            {triggerKind === "cron" ? (
              <>
                <div className="flex flex-col gap-1">
                  <label className="flex flex-col gap-1">
                    <span className="text-[12px] text-fg-dim">{t("automationModal.cron")}</span>
                    <Input value={cron} onChange={(e) => setCron(e.target.value)} />
                  </label>
                  <span className="text-[11px] text-muted">{t("automationModal.cronHint")}</span>
                </div>
                <label className="flex flex-col gap-1">
                  <span className="text-[12px] text-fg-dim">{t("automationModal.timezone")}</span>
                  <Input value={tz} onChange={(e) => setTz(e.target.value)} />
                </label>
              </>
            ) : (
              <>
                <div className="flex flex-col gap-1">
                  <label className="flex flex-col gap-1">
                    <span className="text-[12px] text-fg-dim">{t("automationModal.channels")}</span>
                    <Input value={channels} onChange={(e) => setChannels(e.target.value)} placeholder="C123,C456" />
                  </label>
                  <span className="text-[11px] text-muted">{t("automationModal.channelsHint")}</span>
                </div>
                <div className="flex flex-col gap-1">
                  <label className="flex flex-col gap-1">
                    <span className="text-[12px] text-fg-dim">{t("automationModal.keyword")}</span>
                    <Input value={keyword} onChange={(e) => setKeyword(e.target.value)} />
                  </label>
                  <span className="text-[11px] text-muted">{t("automationModal.keywordHint")}</span>
                </div>
                <div className="flex flex-col gap-1">
                  <label className="flex flex-col gap-1">
                    <span className="text-[12px] text-fg-dim">{t("automationModal.fromUsers")}</span>
                    <Input value={fromUsers} onChange={(e) => setFromUsers(e.target.value)} placeholder="U123,U456" />
                  </label>
                  <span className="text-[11px] text-muted">{t("automationModal.fromUsersHint")}</span>
                </div>
              </>
            )}
          </section>

          {/* ── Model / Execution section (Task 4) */}
          <section className="flex flex-col gap-3">
            <h3 className="eyebrow eyebrow-sm font-semibold uppercase text-fg-dim">{t("automationForm.sectionExecution")}</h3>

            {/* Agent backend (provider) select — applies to BOTH master and worker actions (Task 3), so it sits
                here in the shared section rather than the per-kind Action block below. Labels reuse the
                workerSpawnModal.providerClaude/providerCodex i18n keys (proper nouns, fit as-is). Model select
                below is deliberately left unchanged for codex: it already accepts free-text/unknown ids as a raw
                option, so a codex model override typed/selected there flows through unmodified — no special-casing. */}
            <div className="flex flex-col gap-1">
              <label className="flex flex-col gap-1">
                <span className="text-[12px] text-fg-dim">{t("automationForm.provider")}</span>
                <Select
                  size="md"
                  className="w-full"
                  value={provider}
                  onChange={(e) => setProvider(e.target.value as "claude" | "codex")}
                >
                  <option value="claude">{t("workerSpawnModal.providerClaude")}</option>
                  <option value="codex">{t("workerSpawnModal.providerCodex")}</option>
                </Select>
              </label>
              {/* codex + a non-bypass permissionMode builds an automation that fails every run (per the P2 guard) —
                  mirrors the bypassWarning block's structure below (<p> as a sibling of the <label>, not nested
                  inside it — nesting would make a click on the warning focus the select).
                  MASTER-ONLY: the bypass-only guard applies to master actions only — codex workers map
                  plan → a read-only sandbox and run fine (codex-vocab.ts, automation-action.ts), so a worker
                  action must never trigger this warning even when its permissionMode is non-bypass. */}
              {actionKind === "master" && provider === "codex" && permissionMode !== "bypassPermissions" && (
                <p className="text-[11px] text-run/90" data-testid="codex-bypass-warning">
                  {t("automationForm.codexBypassWarning")}
                </p>
              )}
            </div>

            {/* Model select — codex + a fetched catalog sources options from codexModels instead of the Claude
                `models` list (Task 4); claude or an unfetched catalog (null) keeps today's Claude-list select,
                which already tolerates a free-text/unknown id as a raw extra <option>. Selecting a codex model
                also pre-selects its catalog default effort (mirrors WorkerSpawnModal/NewSessionPage). */}
            <label className="flex flex-col gap-1">
              <span className="text-[12px] text-fg-dim">{t("automationForm.model")}</span>
              <Select
                size="md"
                className="w-full"
                value={model}
                onChange={(e) => {
                  const nm = e.target.value;
                  setModel(nm);
                  if (isCodexList) {
                    const de = codexDefaultEffort(nm, codexModels);
                    if (de) setEffort(de);
                  }
                }}
              >
                <option value="">{t("automationForm.modelDefaultOption")}</option>
                {isCodexList ? (
                  <>
                    {codexModels.map((m) => (
                      <option key={m.id} value={m.id}>{m.displayName}</option>
                    ))}
                    {model && !codexModels.some((m) => m.id === model) && <option value={model}>{model}</option>}
                  </>
                ) : (
                  models.map((m) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))
                )}
              </Select>
            </label>

            {/* Effort select — shown only when a model is selected and effort-supported. Options are the codex
                catalog's per-model efforts when codex+list (falling back to the generic EFFORTS vocabulary for
                an out-of-list model), else the generic EFFORTS list. */}
            {model && modelEffortSupported(model) && (
              <label className="flex flex-col gap-1">
                <span className="text-[12px] text-fg-dim">{t("automationForm.effort")}</span>
                <Select
                  size="md"
                  className="w-full"
                  value={effort}
                  onChange={(e) => setEffort(e.target.value)}
                >
                  {effortOptions.map((e) => (
                    <option key={e} value={e}>{t(effortLabelKey(e))}</option>
                  ))}
                </Select>
              </label>
            )}

            {/* Permission mode select */}
            <div className="flex flex-col gap-1">
              <label className="flex flex-col gap-1">
                <span className="text-[12px] text-fg-dim">{t("automationForm.permissionMode")}</span>
                <Select
                  size="md"
                  className="w-full"
                  value={permissionMode}
                  onChange={(e) => setPermissionMode(e.target.value)}
                  aria-label={t("automationForm.permissionMode")}
                >
                  {permModes.map((pm) => (
                    <option key={pm} value={pm}>{permLabel(pm, t)}</option>
                  ))}
                </Select>
              </label>
              {/* inline bypassPermissions warning — theme run token, not raw Tailwind yellow (audit #79) */}
              {permissionMode === "bypassPermissions" && (
                <p className="text-[11px] text-run/90" data-testid="bypass-warning">
                  {t("automationForm.bypassWarning")}
                </p>
              )}
            </div>

            {/* maxTurns — shown only for the worker action */}
            {actionKind === "worker" && (
              <div className="flex flex-col gap-1">
                <label className="flex flex-col gap-1">
                  <span className="text-[12px] text-fg-dim">{t("automationForm.maxTurns")}</span>
                  <Input
                    type="number"
                    min={1}
                    value={maxTurns}
                    onChange={(e) => setMaxTurns(e.target.value)}
                    placeholder="—"
                  />
                </label>
                <span className="text-[11px] text-muted">{t("automationForm.maxTurnsHint")}</span>
              </div>
            )}

            {/* costBudgetUsd — shown for BOTH action kinds (KEY DIVERGENCE from maxTurns, which is worker-only):
                the daemon checks this at runTurn (master, WARN-only) and at fleet.spawn (worker, STOP). */}
            <div className="flex flex-col gap-1">
              <label className="flex flex-col gap-1">
                <span className="text-[12px] text-fg-dim">{t("automationForm.costBudget")}</span>
                <Input
                  type="number"
                  min={0}
                  step="any"
                  value={costBudget}
                  onChange={(e) => setCostBudget(e.target.value)}
                  placeholder="off"
                />
              </label>
              <span className="text-[11px] text-muted">{t("automationForm.costBudgetHint")}</span>
            </div>
          </section>

          {/* ── Action section */}
          <section className="flex flex-col gap-3">
            <h3 className="eyebrow eyebrow-sm font-semibold uppercase text-fg-dim">{t("automationModal.sectionAction")}</h3>

            <label className="flex flex-col gap-1">
              <span className="text-[12px] text-fg-dim">{t("automationModal.actionType")}</span>
              <Select
                size="md"
                className="w-full"
                value={actionKind}
                onChange={(e) => setActionKind(e.target.value as "master" | "worker")}
              >
                <option value="master">{t("automationPage.typeMaster")}</option>
                <option value="worker">{t("automationPage.typeWorker")}</option>
              </Select>
            </label>

            {actionKind === "master" ? (
              <>
                <div className="flex flex-col gap-1">
                  <span className="text-[12px] text-fg-dim">{t("automationModal.prompt")}</span>
                  <PromptEditor
                    ariaLabel={t("automationModal.prompt")}
                    initialText={mc?.prompt ?? ""}
                    onChange={setPrompt}
                    commands={p.commands}
                    browseDir={p.browseDir ? (d) => p.browseDir!(d, cwd || undefined) : undefined}
                    placeholder=""
                    minHeight={120}
                    className="rounded-[var(--radius)] border border-line bg-ink/60 p-2"
                  />
                </div>
                <label className="flex flex-col gap-1">
                  <span className="text-[12px] text-fg-dim">{t("automationModal.cwd")}</span>
                  <div className="flex gap-2">
                    <Input className="flex-1" value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/path/to/repo" />
                    <Button variant="outline" size="sm" onClick={pickCwd}>
                      {t("settings.browse")}
                    </Button>
                  </div>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[12px] text-fg-dim">{t("automationModal.sessionMode")}</span>
                  <Select
                    size="md"
                    className="w-full"
                    value={sessionMode}
                    onChange={(e) => setSessionMode(e.target.value as "reuse" | "fresh")}
                  >
                    <option value="reuse">{t("automationModal.sessionReuse")}</option>
                    <option value="fresh">{t("automationModal.sessionFresh")}</option>
                  </Select>
                </label>
              </>
            ) : (
              <>
                <label className="flex flex-col gap-1">
                  <span className="text-[12px] text-fg-dim">{t("automationModal.repo")}</span>
                  <Select
                    size="md"
                    className="w-full"
                    value={repo}
                    onChange={(e) => setRepo(e.target.value)}
                  >
                    {p.repos.map((r) => (
                      <option key={r.name} value={r.name}>
                        {r.name}
                      </option>
                    ))}
                  </Select>
                </label>
                <div className="flex flex-col gap-1">
                  <span className="text-[12px] text-fg-dim">{t("automationModal.task")}</span>
                  <PromptEditor
                    ariaLabel={t("automationModal.task")}
                    initialText={wc?.task ?? ""}
                    onChange={setTask}
                    commands={p.commands}
                    browseDir={p.browseDir && repoPath ? (d) => p.browseDir!(d, repoPath) : undefined}
                    minHeight={120}
                    className="rounded-[var(--radius)] border border-line bg-ink/60 p-2"
                  />
                </div>
                <label className="flex flex-col gap-1">
                  <span className="text-[12px] text-fg-dim">{t("automationModal.base")}</span>
                  <Input value={base} onChange={(e) => setBase(e.target.value)} />
                </label>
              </>
            )}

            {triggerKind === "slack" && actionKind === "master" && (
              <p className="text-[11px] text-run/90">{t("automationModal.slackMasterCaution")}</p>
            )}
            <p className="text-[11px] text-muted">{t("automationModal.templateHint")}</p>
          </section>

          {/* Save row — body-bottom, matching SettingsPage's Save placement (audit #75) */}
          <div className="flex items-center justify-end gap-2 border-t border-line pt-4">
            <Button variant="ghost" size="sm" onClick={p.onClose}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" size="sm" loading={saving} disabled={!valid} onClick={() => { void submit(); }}>
              {t("common.save")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
