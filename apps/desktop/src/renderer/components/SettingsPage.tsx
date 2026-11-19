import { SpeedControl } from "./SpeedControl.js";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { rovingIndex, usePageEscape } from "../lib/focus.js";
import { withShortcut } from "../lib/shortcuts.js";
import type { SettingsValues } from "@daemon/core/settings.js";
import type { SlackStatus } from "@daemon/core/events.js";
import type { IntegrationsStatus } from "@daemon/protocol/messages.js";
import type { AuthStatus } from "@daemon/core/auth-status.js";
import { AlertTriangle, Loader2, X } from "lucide-react";
import { Button } from "../ui/button.js";
import { UpdateSettings } from "./UpdateSettings.js";
import { Input, Select } from "../ui/input.js";
import { Segment, type SegmentItem } from "../ui/segment.js";
import { EFFORTS, effortLabelKey, effortSupported } from "../lib/models.js";
import { useStore } from "../store/store.js";
import { cn } from "../lib/cn.js";
import { useT } from "../i18n/provider.js";
import { usePrefsStore } from "../store/prefs.js";
import type { LocalePref } from "../i18n/types.js";
import { ConfirmDialog } from "../ui/confirm-dialog.js";
import { CapabilityScopeBindings } from "./capabilities/CapabilityScopeBindings.js";
import type { CapabilityCenterApi } from "./capabilities/types.js";
import { changedSettingKeys, dirtyTabs, msParts, toSettingsDraft, type SettingsTab } from "../lib/settings-draft.js";
import { setLeaveGuard } from "../lib/leave-guard.js";

// VS Code settings composition (rookery-ide-ui skill): a scrolling list of settings, each = title (13px medium),
// description (12px muted), control beneath — no wells, no right-aligned control column (that squeezed the
// description into a ~260px column at 920px wide, audit #95, and made the control edge zig-zag, #110). A group
// heading (`Section`) is used only where several settings belong together; a lone setting stands on its own
// instead of repeating its title as a heading (#91). `Row` keeps a fixed-width control; `WideRow` a full-width one.
// Both wrap the setting in a <label> so the control keeps its implicit accessible name; `CheckRow` puts a checkbox
// before its title (VS Code's boolean setting); status-only rows (no control) use `StatusRow`. `break-keep` on the
// page keeps Korean words whole when a line wraps.
function Section({ title, desc, children }: { title: string; desc?: string; children: ReactNode }): JSX.Element {
  return (
    <section>
      <h2 className="border-b border-line-soft pb-2 text-title font-medium text-fg">{title}</h2>
      {desc && <p className="mt-2 max-w-[70ch] text-ui leading-relaxed text-muted">{desc}</p>}
      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </section>
  );
}

function SettingText({ label, hint }: { label: ReactNode; hint?: ReactNode }): JSX.Element {
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="text-body font-medium text-fg">{label}</span>
      {hint && <span className="max-w-[70ch] text-ui leading-relaxed text-muted">{hint}</span>}
    </span>
  );
}

function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <label className="flex flex-col items-start gap-1.5">
      <SettingText label={label} hint={hint} />
      <span className="flex max-w-full items-center gap-2">{children}</span>
    </label>
  );
}

function WideRow({ label, hint, children }: { label?: ReactNode; hint?: ReactNode; children: ReactNode }): JSX.Element {
  // No label → this is a plain content row (e.g. a status line + its own control), not a form field, so it's a
  // <div> rather than a <label> (nothing to implicitly associate a control with).
  const Tag = label ? "label" : "div";
  return (
    <Tag className="flex flex-col items-stretch gap-1.5">
      {label && <SettingText label={label} hint={hint} />}
      {children}
    </Tag>
  );
}

function CheckRow({ label, hint, checked, onChange }: { label: ReactNode; hint?: ReactNode; checked: boolean; onChange: (checked: boolean) => void }): JSX.Element {
  return (
    <label className="flex items-start gap-2">
      <input type="checkbox" className="mt-[3px] accent-fg-dim" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <SettingText label={label} hint={hint} />
    </label>
  );
}

function StatusRow({ children }: { children: ReactNode }): JSX.Element {
  return <div className="flex items-center gap-3">{children}</div>;
}

// "= 2 min" under a millisecond field (audit #119): the stored unit stays ms (the daemon reads raw ms strings), the
// helper text says what the number means. `offKey` names what 0 does for this setting; without it 0 says nothing.
function MsHint({ value, offKey }: { value: string | undefined; offKey?: string }): JSX.Element | null {
  const t = useT();
  const parts = msParts(value);
  if (!parts) return null;
  if (parts.unit === "off") return offKey ? <span className="text-ui text-muted">{t(offKey)}</span> : null;
  return <span className="text-ui tabular-nums text-muted">{t(`settings.ms_${parts.unit}`, { count: parts.value })}</span>;
}

// A write-only secret action (API key, tokens): the typed value stays in the field until the daemon confirms the
// save, and the button shows progress meanwhile (audit #94). A failed save keeps the value so it can be retried
// (the App path reports the failure once, as a toast).
function useSecretSave(): { busy: boolean; run: (action: () => unknown, onSaved: () => void) => void } {
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const run = (action: () => unknown, onSaved: () => void): void => {
    let result: unknown;
    setBusy(true);
    try { result = action(); } catch { setBusy(false); return; }
    void Promise.resolve(result).then(
      () => { if (alive.current) { setBusy(false); onSaved(); } },
      () => { if (alive.current) setBusy(false); },
    );
  };
  return { busy, run };
}

type Tab = SettingsTab;
type ModelsProvider = "claude" | "codex";
// Categories whose settings are all form-backed: the Save bar is always shown there. Integrations and
// Capabilities have no draft fields of their own, so the bar appears there only while something is unsaved.
const FORM_TABS: ReadonlySet<Tab> = new Set<Tab>(["general", "slack", "models"]);

// A status probe that failed (instead of "checking…" forever, audit #47): says so and offers a re-check that shows
// progress. The probe re-runs on its own each time Settings opens.
function CheckFailed({ onRecheck }: { onRecheck?: () => Promise<void> }): JSX.Element {
  const t = useT();
  const [busy, setBusy] = useState(false);
  return (
    <span className="ml-auto flex shrink-0 items-center gap-2 text-ui text-muted">
      {t("settings.checkFailed")}
      {onRecheck && (
        <Button variant="outline" size="sm" loading={busy} aria-label={t("settings.recheck")} onClick={() => { setBusy(true); void onRecheck().catch(() => {}).finally(() => setBusy(false)); }}>
          {t("settings.recheck")}
        </Button>
      )}
    </span>
  );
}

// Save model (audit #93): every form setting is a draft until the Save bar's Save — one model, one button, pinned
// under the list so it is never scrolled away, with the unsaved count and a dot on each category that holds changes.
// Two kinds of control deliberately act at once and say so: the app language (a local display preference) and the
// Slack on/off switch (a connection action, not a stored value). Secrets (API keys, tokens) are write-only actions
// with their own button next to the field — they can't be shown back, so they can't be part of a revertable draft.
export function SettingsPage(p: { settings: SettingsValues; onSave: (next: SettingsValues) => void | Promise<void>; onClose: () => void; slack: SlackStatus; onSlackToggle: (enabled: boolean) => void; integrations?: IntegrationsStatus | null; authStatus?: AuthStatus | null; integrationsFailed?: boolean; authStatusFailed?: boolean; onRecheckStatus?: () => Promise<void>; onSaveLinearKey?: (key: string) => void | Promise<void>; onSaveSlackTokens?: (bot: string, app: string) => void | Promise<void>; onSaveAnthropicKey?: (key: string) => void | Promise<void>; onSaveCodexKey?: (key: string) => void | Promise<void>; mcpStatus?: { scope: "off" | "readonly" | "full"; url: string | null } | null; onRegenerateMcpToken?: () => void; capabilityApi?: CapabilityCenterApi; capabilityGeneration?: number; onOpenCapabilityCatalog?: () => void; onOpenCapabilityAssignments?: () => void; onPreviewCapabilities?: () => void }): JSX.Element {
  const t = useT();
  const localePref = usePrefsStore((s) => s.localePref);
  const setLocalePref = usePrefsStore((s) => s.setLocalePref);
  const [tab, setTab] = useState<Tab>("general");
  const railId = useId().replace(/:/g, "");
  // Which provider's config the "Models" tab shows — a pill sub-toggle inside that tab. Ephemeral
  // (defaults to Claude each open), matching the top-level `tab`'s non-persisted behavior.
  const [modelsProvider, setModelsProvider] = useState<ModelsProvider>("claude");
  const [f, setF] = useState<SettingsValues>(() => toSettingsDraft(p.settings));
  const [linKey, setLinKey] = useState("");
  const [slackBot, setSlackBot] = useState("");
  const [slackApp, setSlackApp] = useState("");
  const [anthropicKey, setAnthropicKey] = useState("");
  const [codexKey, setCodexKey] = useState("");
  // Codex has no auth-status probe (unlike Anthropic's live check above) — this local flag is the only signal
  // that a key was saved this session, driving the same "saved" placeholder idiom the slack token fields use.
  const [codexKeySaved, setCodexKeySaved] = useState(false);
  const linSave = useSecretSave();
  const slackSave = useSecretSave();
  const anthropicSave = useSecretSave();
  const codexSave = useSecretSave();
  const models = useStore((s) => s.models); // live model list (initialized from the static fallback if none)
  const codexModels = useStore((s) => s.codexModels); // codex catalog from codex.models.list; null = couldn't fetch → free-text fallback for the defaults below
  const codexAuthStatus = useStore((s) => s.codexAuthStatus); // codex backend auth readiness (codex.authStatus); null = still probing / probe failed → "checking"

  // Slack on/off toggle: the request is fire-and-forget from here, so between the click and the daemon's slack.status
  // event landing (prop change) the button showed no feedback at all (audit #53). `busy` covers that window; a fallback
  // timer clears it even if no status event ever arrives (e.g. the request itself rejects) so the button can't get stuck.
  const [slackToggleBusy, setSlackToggleBusy] = useState(false);
  const slackToggleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    setSlackToggleBusy(false);
    if (slackToggleTimer.current) { clearTimeout(slackToggleTimer.current); slackToggleTimer.current = null; }
  }, [p.slack]);
  useEffect(() => () => { if (slackToggleTimer.current) clearTimeout(slackToggleTimer.current); }, []);
  const handleSlackToggle = (): void => {
    setSlackToggleBusy(true);
    p.onSlackToggle(p.slack === "off");
    slackToggleTimer.current = setTimeout(() => setSlackToggleBusy(false), 6000);
  };
  const changed = changedSettingKeys(f, toSettingsDraft(p.settings));
  const dirty = changed.length > 0;
  const tabsWithChanges = dirtyTabs(changed);
  const allowAll = f.slackAllowAll === "1";
  const refuseReply = f.slackRefuseReply === "1";
  // Same rule as the spawn page and the automation form: an entered budget is a positive amount, never silently dropped.
  const budgetText = (f.workerCostBudgetUsd ?? "").trim();
  const budgetInvalid = budgetText !== "" && !(Number.isFinite(Number(budgetText)) && Number(budgetText) > 0);

  const [saving, setSaving] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const budgetRef = useRef<HTMLInputElement>(null);
  const inflight = useRef<Promise<boolean> | null>(null);
  // Resolves true once the daemon accepted the settings; false on failure (the App path toasts it) — the draft stays.
  // A save already running is joined rather than refused, so "Save and close" during it closes when it lands. An
  // invalid budget refuses with its reason in view: the General category opens and the field takes focus.
  const save = (): Promise<boolean> => {
    if (inflight.current) return inflight.current;
    if (budgetInvalid) {
      setTab("general");
      requestAnimationFrame(() => budgetRef.current?.focus());
      return Promise.resolve(false);
    }
    setSaving(true);
    const run = (async () => {
      try {
        await p.onSave(f);
        return true;
      } catch {
        return false;
      } finally {
        inflight.current = null;
        if (alive.current) setSaving(false);
      }
    })();
    inflight.current = run;
    return run;
  };

  // Leaving with unsaved edits asks first (audit #18) — the header X, the in-page Capability Center links, and App
  // navigation (sidebar, settings gear, back/forward) through the store's leave guard. "Save and close" leaves only
  // once the save succeeded (audit #93). `pendingLeave` is the move the dialog will make; `leaving` lets that move
  // pass the guard once the user chose.
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const leaving = useRef(false);
  const leave = (action: () => void): void => {
    leaving.current = true;
    try { action(); } finally { leaving.current = false; }
  };
  const requestLeave = (action: () => void): void => {
    if (dirtyRef.current) setPendingLeave(() => action);
    else action();
  };
  useEffect(() => setLeaveGuard((proceed) => {
    if (leaving.current || !dirtyRef.current) return false;
    setPendingLeave(() => proceed);
    return true;
  }), []);
  const [confirmRegen, setConfirmRegen] = useState(false); // rotating the MCP token cuts off every registered client (audit #103)
  const [mcpCopied, setMcpCopied] = useState(false);
  const copyMcpUrl = (url: string): void => {
    void navigator.clipboard.writeText(url).then(() => { setMcpCopied(true); window.setTimeout(() => setMcpCopied(false), 1500); }).catch(() => {});
  };
  const requestClose = (): void => requestLeave(p.onClose);
  usePageEscape(requestClose); // Escape closes like the header X — through the same unsaved-changes guard (audit #129)

  // Native folder-picker dialog (preload bridge), same as for worktree/session cwd.
  const pickCwd = async (): Promise<void> => {
    const dir = await window.rookery.pickDirectory();
    if (dir) setF((cur) => ({ ...cur, slackCwd: dir }));
  };
  const pickDefaultCwd = async (): Promise<void> => {
    const dir = await window.rookery.pickDirectory();
    if (dir) setF((cur) => ({ ...cur, defaultSessionCwd: dir }));
  };

  const tabs: Array<SegmentItem<Tab>> = [
    { value: "general", label: t("settings.tabGeneral") },
    { value: "slack", label: "Slack" },
    { value: "models", label: t("settings.tabModels") },
    ...(p.capabilityApi ? [{ value: "capabilities" as const, label: t("settings.tabCapabilities") }] : []),
    { value: "integration", label: t("settings.integrations") },
  ];
  // Sub-toggle items for the Models tab (pill grammar — an in-form selection, distinct from the nav-tier underline tabs).
  const modelsProviders: Array<SegmentItem<ModelsProvider>> = [
    { value: "claude", label: "Claude" },
    { value: "codex", label: t("settings.tabCodex") },
  ];
  const showSaveBar = FORM_TABS.has(tab) || dirty;

  // Claude/Codex model selects share one shape: the live list plus the saved value when it isn't in the list.
  // The first option ("") follows the SDK's recommended model for this account; it names the model it stands for.
  const modelName = (id: string): string => models.find((m) => m.id === id)?.label ?? id;
  const followModel = (role: "master" | "worker"): string => {
    if (p.settings.claudeRecommendedModel) return p.settings.claudeRecommendedModel;
    const src = role === "master" ? p.settings.masterModelSource : p.settings.workerModelSource;
    return src && src !== "setting" ? (role === "master" ? p.settings.masterModel : p.settings.workerModel) : "";
  };
  const claudeModelOptions = (value: string, role: "master" | "worker"): JSX.Element => {
    const follow = followModel(role);
    const label = p.settings.claudeRecommendedModel
      ? t("settings.claudeModelRecommended", { name: modelName(follow) })
      : follow ? t("settings.claudeModelDefault", { name: modelName(follow) }) : t("settings.claudeModelDefaultPlain");
    return (
      <>
        <option value="">{label}</option>
        {models.map((m) => (<option key={m.id} value={m.id}>{m.label}</option>))}
        {value && !models.some((m) => m.id === value) && <option value={value}>{value}</option>}
      </>
    );
  };
  // The model a "" draft stands for, for controls that need a concrete id (effort support, Fast availability).
  const effectiveModel = (value: string, role: "master" | "worker"): string =>
    value || followModel(role) || (role === "master" ? p.settings.masterModel : p.settings.workerModel);
  const codexModelField = (value: string | undefined, onChange: (v: string) => void): JSX.Element => (
    codexModels != null ? (
      <Select className="w-[240px]" value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t("settings.codexModelDefaultOption")}</option>
        {codexModels.map((m) => (
          <option key={m.id} value={m.id}>{m.displayName}</option>
        ))}
        {value && !codexModels.some((m) => m.id === value) && <option value={value}>{value}</option>}
      </Select>
    ) : (
      <Input className="w-[240px]" value={value ?? ""} placeholder="gpt-6.1-sol" onChange={(e) => onChange(e.target.value)} />
    )
  );

  return (
    <>
      <div className="drag flex h-10 shrink-0 items-center gap-2 px-4">
        <span className="text-body font-medium text-fg">{t("settings.title")}</span>
        <Button variant="ghost" size="iconSm" className="no-drag ml-auto" onClick={requestClose} aria-label={t("settings.close")} title={withShortcut(t("settings.close"), "Esc")}>
          <X size={14} />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1">
        {/* category rail — VS Code settings layout: a left list of categories (not tabs-as-pills). A dot marks a
            category that holds unsaved changes. */}
        {/* Tab pattern done fully (audit #131): one tab stop (the selected category), ArrowUp/Down/Home/End move and
            select, and the panel is labelled by its tab. */}
        <nav
          role="tablist"
          aria-label={t("settings.title")}
          aria-orientation="vertical"
          onKeyDown={(e) => {
            const i = rovingIndex(e.key, tabs.findIndex((x) => x.value === tab), tabs.length);
            if (i === null) return;
            e.preventDefault();
            const next = tabs[i]!.value;
            setTab(next);
            document.getElementById(`${railId}-tab-${next}`)?.focus();
          }}
          className="w-[160px] shrink-0 overflow-y-auto bg-sunk py-2"
        >
          {tabs.map((item) => (
            <button
              key={item.value}
              id={`${railId}-tab-${item.value}`}
              type="button"
              role="tab"
              aria-selected={tab === item.value}
              aria-controls={`${railId}-panel`}
              tabIndex={tab === item.value ? 0 : -1}
              onClick={() => setTab(item.value)}
              className={cn(
                "flex h-[26px] w-full items-center gap-2 px-3 text-left text-body transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent-hi",
                tab === item.value ? "bg-raised text-fg" : "text-muted hover:bg-raised/60 hover:text-fg-dim",
              )}
            >
              {item.label}
              {tabsWithChanges.has(item.value) && <span data-dirty-dot className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-fg-dim" aria-hidden />}
            </button>
          ))}
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={cn("break-keep px-6 py-6", tab === "capabilities" ? "max-w-[880px]" : "max-w-[720px]")}>
          <div key={tab} id={`${railId}-panel`} role="tabpanel" aria-labelledby={`${railId}-tab-${tab}`} className="rise-in">
            {tab === "general" && (
              <div className="flex flex-col gap-6">
                <Row label={t("settings.botName")} hint={t("settings.botNameDesc")}>
                  <Input className="w-[240px]" value={f.masterName ?? ""} placeholder="rookery" maxLength={64} onChange={(e) => setF({ ...f, masterName: e.target.value })} />
                </Row>

                <WideRow label={t("settings.defaultFolder")} hint={<>{t("settings.defaultFolderDesc")} {t("settings.defaultFolderHint")}</>}>
                  <div className="flex gap-2">
                    <Input className="min-w-0 flex-1 font-mono text-ui" title={f.defaultSessionCwd || undefined} value={f.defaultSessionCwd ?? ""} placeholder={t("settings.defaultFolderPlaceholder")} onChange={(e) => setF({ ...f, defaultSessionCwd: e.target.value })} />
                    <Button variant="outline" size="md" onClick={pickDefaultCwd}>{t("settings.browse")}</Button>
                  </div>
                </WideRow>

                {/* Worker model/effort defaults live in Models → per provider. The cost budget is provider-agnostic
                    (applies to Claude AND Codex workers), so it stays here in General. */}
                <div className="flex flex-col gap-1.5">
                  <Row label={t("settings.workerBudget")} hint={<>{t("settings.workerCostBudgetUsdHint")} {t("speed.budgetEstimated")}</>}>
                    <Input ref={budgetRef} type="number" className={cn("w-[120px] tabular-nums", budgetInvalid && "border-fail")} value={f.workerCostBudgetUsd ?? ""} placeholder={t("common.noLimit")} aria-invalid={budgetInvalid || undefined} aria-describedby={budgetInvalid ? "settings-budget-error" : undefined} onChange={(e) => setF({ ...f, workerCostBudgetUsd: e.target.value })} />
                    <span className="text-ui text-muted">USD</span>
                  </Row>
                  {budgetInvalid && <p id="settings-budget-error" className="text-ui text-fail">{t("workerSpawnModal.budgetInvalid")}</p>}
                </div>

                <div className="flex flex-col gap-1.5">
                  <Row label={t("settings.usageRefreshMs")} hint={t("settings.usageDesc")}>
                    <Input type="number" className="w-[120px] tabular-nums" placeholder="120000" value={f.usageRefreshMs ?? ""} onChange={(e) => setF({ ...f, usageRefreshMs: e.target.value })} />
                    <MsHint value={f.usageRefreshMs || "120000"} />
                  </Row>
                </div>

                <Row label={t("settings.language")} hint={<>{t("settings.languageDesc")} {t("settings.appliesNow")}</>}>
                  <Select className="w-[240px]" value={localePref} onChange={(e) => setLocalePref(e.target.value as LocalePref)}>
                    <option value="system">{t("settings.langSystem")}</option>
                    <option value="ko">한국어</option>
                    <option value="en">English</option>
                  </Select>
                </Row>

                {/* External MCP server (rookery-as-MCP): expose fleet control to external MCP clients (Claude Code /
                    Cursor / Codex). Off by default (fail-closed). The scope is f-backed (saved via the Save bar);
                    the URL/token are live actions reflecting the SAVED state (mcpStatus). */}
                <div>
                  <Section title={t("settings.mcpTitle")} desc={t("settings.mcpDesc")}>
                    <Row label={t("settings.mcpExposureLabel")} hint={t("settings.mcpExposureHint")}>
                      <Select className="w-[240px]" value={f.mcpExposure ?? "off"} onChange={(e) => setF({ ...f, mcpExposure: e.target.value })}>
                        <option value="off">{t("settings.mcpScopeOff")}</option>
                        <option value="readonly">{t("settings.mcpScopeReadonly")}</option>
                        <option value="full">{t("settings.mcpScopeFull")}</option>
                      </Select>
                    </Row>
                    {f.mcpExposure !== "off" && (
                      p.mcpStatus?.url ? (
                        <WideRow>
                          <p className="text-ui leading-relaxed text-muted">{t("settings.mcpAddHint")}</p>
                          <div className="flex gap-2">
                            <Input readOnly value={p.mcpStatus.url} className="min-w-0 flex-1 font-mono text-ui" onFocus={(e) => e.currentTarget.select()} />
                            <Button variant="outline" size="md" onClick={() => copyMcpUrl(p.mcpStatus!.url!)}>{mcpCopied ? t("settings.mcpCopied") : t("settings.mcpCopy")}</Button>
                          </div>
                          <div>
                            <Button variant="outline" size="sm" onClick={() => setConfirmRegen(true)}>{t("settings.mcpRegenerate")}</Button>
                          </div>
                        </WideRow>
                      ) : (
                        <div className="text-ui leading-relaxed text-muted">{t("settings.mcpSaveToActivate")}</div>
                      )
                    )}
                  </Section>
                  {f.mcpExposure === "full" && (
                    <div className="mt-2 flex items-start gap-2 rounded-md border border-warn/30 bg-warn/5 px-3 py-2 text-ui leading-relaxed text-fg-dim">
                      <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warn" />
                      <span>{t("settings.mcpFullWarning")}</span>
                    </div>
                  )}
                </div>

                <UpdateSettings />
              </div>
            )}

            {tab === "slack" && (
              <div className="flex flex-col gap-8">
                <Section title="Slack" desc={t("settings.slackDesc")}>
                  <StatusRow>
                    <span className={cn("h-2 w-2 shrink-0 rounded-full transition-colors duration-200",
                      p.slack === "up" ? "bg-pr" : p.slack === "connecting" ? "bg-run text-run led-live" : p.slack === "error" ? "bg-fail" : "bg-stop")} />
                    <span className="text-body text-fg">
                      {p.slack === "up" ? t("settings.slackUp") : p.slack === "connecting" ? t("settings.slackConnecting") : p.slack === "error" ? t("settings.slackError") : p.slack === "off" ? t("settings.slackOff") : t("settings.slackNoToken")}
                    </span>
                    {/* A connection action, applied at once (not part of the Save bar's draft). */}
                    <button
                      onClick={handleSlackToggle}
                      disabled={p.slack === "unconfigured" || slackToggleBusy}
                      aria-busy={slackToggleBusy || undefined}
                      title={t("settings.appliesNow")}
                      className={cn("ml-auto flex items-center gap-1.5 rounded-sm border border-line px-2.5 py-1 text-meta font-medium text-fg-dim transition-colors duration-150 hover:bg-raised hover:text-fg disabled:opacity-40")}
                    >
                      {slackToggleBusy && <Loader2 size={12} className="animate-spin" aria-hidden />}
                      {p.slack === "off" ? t("settings.toggleOn") : t("settings.toggleOff")}
                    </button>
                  </StatusRow>
                  {p.slack === "unconfigured" && (
                    <div className="text-ui leading-relaxed text-muted">{t("settings.slackUnconfigured")}</div>
                  )}

                  {/* Tokens get a full line each — they're quite long, so a half-width field would cut them off. */}
                  {/* Any status other than "unconfigured" means tokens are already saved (write-only secrets are never echoed
                      back), so the empty xoxb-…/xapp-… hint would misleadingly read as "not set" (audit #41). */}
                  <WideRow label={t("settings.slackBotToken")} hint={t("settings.slackTokensDesc")}>
                    <Input type="password" placeholder={p.slack !== "unconfigured" ? t("settings.secretSaved") : "xoxb-…"} value={slackBot} onChange={(e) => setSlackBot(e.target.value)} />
                  </WideRow>
                  <WideRow label={t("settings.slackAppToken")}>
                    <Input type="password" placeholder={p.slack !== "unconfigured" ? t("settings.secretSaved") : "xapp-…"} value={slackApp} onChange={(e) => setSlackApp(e.target.value)} />
                  </WideRow>
                  <div>
                    <Button variant="outline" size="sm" loading={slackSave.busy} disabled={!slackBot.trim() || !slackApp.trim()} onClick={() => slackSave.run(() => p.onSaveSlackTokens?.(slackBot.trim(), slackApp.trim()), () => { setSlackBot(""); setSlackApp(""); })}>{t("settings.slackTokensSave")}</Button>
                  </div>
                </Section>

                <Section title={t("settings.slackAccess")}>
                  <CheckRow label={t("settings.slackAllowAll")} checked={allowAll} onChange={(on) => setF({ ...f, slackAllowAll: on ? "1" : "0" })} />
                  {/* When allow-all is on, the allowlist is meaningless → disable the input. */}
                  <WideRow label={t("settings.slackAllowedUsers")} hint={t("settings.slackAllowedUsersHint")}>
                    <Input className="font-mono text-ui" value={f.slackAllowedUsers ?? ""} placeholder="U123,U456" disabled={allowAll} onChange={(e) => setF({ ...f, slackAllowedUsers: e.target.value })} />
                  </WideRow>
                  <CheckRow label={t("settings.slackRefuseReply")} checked={refuseReply} onChange={(on) => setF({ ...f, slackRefuseReply: on ? "1" : "0" })} />
                  {/* When auto-reply is off, disable the message input. */}
                  <WideRow label={t("settings.slackRefusalMessage")} hint={t("settings.slackRefusalMessageHint")}>
                    <Input value={f.slackRefusalMessage ?? ""} disabled={!refuseReply} onChange={(e) => setF({ ...f, slackRefusalMessage: e.target.value })} />
                  </WideRow>
                </Section>

                <Section title={t("settings.slackBehavior")}>
                  <WideRow label={t("settings.slackCwd")} hint={t("settings.slackCwdHint")}>
                    <div className="flex gap-2">
                      <Input className="min-w-0 flex-1 font-mono text-ui" title={f.slackCwd || undefined} value={f.slackCwd ?? ""} onChange={(e) => setF({ ...f, slackCwd: e.target.value })} />
                      <Button variant="outline" size="md" onClick={pickCwd}>{t("settings.browse")}</Button>
                    </div>
                  </WideRow>
                  <Row label={t("settings.slackLocale")} hint={t("settings.slackLocaleHint")}>
                    <Select className="w-[240px]" value={f.slackLocale ?? "ko"} onChange={(e) => setF({ ...f, slackLocale: e.target.value })}>
                      <option value="ko">한국어</option>
                      <option value="en">English</option>
                    </Select>
                  </Row>
                  <Row label={t("settings.slackProvider")} hint={t("settings.slackProviderHint")}>
                    <Select className="w-[240px]" value={f.slackProvider ?? "claude"} onChange={(e) => setF({ ...f, slackProvider: e.target.value })}>
                      <option value="claude">{t("workerSpawnModal.providerClaude")}</option>
                      <option value="codex">{t("workerSpawnModal.providerCodex")}</option>
                    </Select>
                  </Row>
                  <CheckRow label={t("settings.workerRelay")} hint={t("settings.workerRelayDesc")} checked={f.workerSlackRelayEnabled === "1"} onChange={(on) => setF({ ...f, workerSlackRelayEnabled: on ? "1" : "0" })} />
                  <WideRow label={t("settings.workerRelayChannel")} hint={t("settings.workerRelayChannelHint")}>
                    <Input className="font-mono text-ui" value={f.workerSlackRelayChannel ?? ""} placeholder="C0123456789" disabled={f.workerSlackRelayEnabled !== "1"} onChange={(e) => setF({ ...f, workerSlackRelayChannel: e.target.value })} />
                  </WideRow>
                </Section>
              </div>
            )}

            {tab === "integration" && (
              <Section title={t("settings.integrations")} desc={t("settings.integrationsDesc")}>
                {/* While integrations is still null (loading, or a silently-swallowed request failure), don't assert
                    "auth needed" — that reads as a confident negative when we simply don't know yet (audit #15). */}
                <StatusRow>
                  <span className={cn("h-2 w-2 shrink-0 rounded-full transition-colors duration-200", p.integrations?.github.available ? "bg-pr" : "bg-stop")} />
                  <span className="flex min-w-0 items-center gap-1.5 text-body text-fg">
                    <span>GitHub (gh CLI)</span>
                    {p.integrations?.github.available && (
                      <>
                        <span className="h-3 w-px shrink-0 bg-line" aria-hidden />
                        <span className="truncate text-muted">{p.integrations.github.user ?? t("settings.githubConnected")}</span>
                      </>
                    )}
                  </span>
                  {!p.integrations && p.integrationsFailed ? (
                    <CheckFailed onRecheck={p.onRecheckStatus} />
                  ) : !p.integrations ? (
                    <span className="ml-auto shrink-0 text-ui text-muted">{t("settings.checking")}</span>
                  ) : !p.integrations.github.available ? (
                    <span className="ml-auto shrink-0 text-ui text-muted">{t("settings.ghAuthNeeded")}</span>
                  ) : null}
                </StatusRow>

                <WideRow>
                  <div className="flex items-center gap-3">
                    <span className={cn("h-2 w-2 shrink-0 rounded-full transition-colors duration-200", p.integrations?.linear.valid ? "bg-pr" : p.integrations?.linear.configured ? "bg-fail" : "bg-stop")} />
                    <span className="flex min-w-0 items-center gap-1.5 text-body text-fg">
                      Linear
                      {(() => {
                        const status = !p.integrations
                          ? t(p.integrationsFailed ? "settings.checkFailed" : "settings.checking")
                          : p.integrations.linear.valid
                            ? (p.integrations.linear.user ?? t("settings.linearConnected"))
                            : p.integrations.linear.configured
                              ? t("settings.linearKeyInvalid")
                              : null;
                        // The status text stays a direct sibling text node (not its own element) so it never collides
                        // with the GitHub row's standalone "checking" badge under an exact-text query.
                        return status ? (<><span className="h-3 w-px shrink-0 bg-line" aria-hidden />{status}</>) : null;
                      })()}
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <Input
                      type="password"
                      className="min-w-0 flex-1"
                      placeholder={p.integrations?.linear.configured ? t("settings.linearReplace") : t("settings.linearPlaceholder")}
                      value={linKey}
                      onChange={(e) => setLinKey(e.target.value)}
                    />
                    <Button variant="outline" size="md" loading={linSave.busy} disabled={!linKey.trim()} onClick={() => linSave.run(() => p.onSaveLinearKey?.(linKey.trim()), () => setLinKey(""))}>{t("common.connect")}</Button>
                  </div>
                </WideRow>
              </Section>
            )}

            {tab === "capabilities" && p.capabilityApi && (
              <CapabilityScopeBindings
                scopeKind="rookery"
                scopeRef=""
                api={p.capabilityApi}
                generation={p.capabilityGeneration ?? 0}
                onOpenCatalog={() => requestLeave(p.onOpenCapabilityCatalog ?? (() => {}))}
                onOpenAdvancedAssignments={() => requestLeave(p.onOpenCapabilityAssignments ?? (() => {}))}
                onPreviewEffective={() => requestLeave(p.onPreviewCapabilities ?? (() => {}))}
              />
            )}

            {tab === "models" && (
              <>
                {/* pill sub-toggle (in-form selection) — visually distinct from the category list */}
                <Segment
                  items={modelsProviders}
                  value={modelsProvider}
                  onChange={setModelsProvider}
                  variant="pill"
                  className="mb-6 max-w-[280px]"
                  itemClassName="px-3 py-1.5 text-ui font-medium"
                />

                {modelsProvider === "claude" && (() => {
              const a = p.authStatus;
              // While authStatus is still null (loading, or a silently-swallowed request failure), don't default to
              // method="none" — that renders a confident "No auth active" even when a key is actually working (audit #15).
              const checking = a == null;
              const checkFailed = checking && !!p.authStatusFailed;
              const method = a?.method ?? "none";
              const dotCls = checking ? "bg-stop" : method === "api-key" ? "bg-accent" : method === "oauth" ? "bg-pr" : "bg-stop";
              const label = checkFailed ? "" : checking ? t("settings.checking") : method === "api-key" ? t("settings.claudeMethodApiKey") : method === "oauth" ? t("settings.claudeMethodSubscription") : t("settings.claudeMethodNone");
              const desc = method === "api-key" ? t("settings.claudeApiKeyActive") : method === "oauth" ? t("settings.claudeSubscriptionActive") : t("settings.claudeNoneActive");
              return (
                <div className="flex flex-col gap-8">
                <div>
                  <Section title={t("settings.claudeAuthTitle")} desc={t("settings.claudeAuthDesc")}>
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center justify-between gap-3">
                        <span className="flex items-center gap-2 text-body font-medium text-fg">
                          <span className={cn("h-2 w-2 shrink-0 rounded-full", dotCls)} />
                          {label}
                        </span>
                        {a?.method === "api-key" && a.apiKeyHint && <span className="shrink-0 font-mono text-ui text-muted">{a.apiKeyHint}</span>}
                        {checkFailed && <CheckFailed onRecheck={p.onRecheckStatus} />}
                      </div>
                      {!checking && <p className="text-ui leading-relaxed text-muted">{desc}</p>}
                    </div>
                    <WideRow label={t("settings.anthropicApiKey")} hint={t("settings.anthropicApiKeyHint")}>
                      <div className="flex gap-2">
                        <Input type="password" className="min-w-0 flex-1" placeholder="sk-ant-…" value={anthropicKey} onChange={(e) => setAnthropicKey(e.target.value)} />
                        <Button variant="outline" size="md" aria-label={t("settings.anthropicKeySave")} loading={anthropicSave.busy} disabled={!anthropicKey.trim()} onClick={() => anthropicSave.run(() => p.onSaveAnthropicKey?.(anthropicKey.trim()), () => setAnthropicKey(""))}>{t("common.save")}</Button>
                      </div>
                    </WideRow>
                  </Section>
                  {a?.overridesSubscription && (
                    <div className="mt-2 flex items-start gap-2 rounded-md border border-warn/30 bg-warn/5 px-3 py-2.5 text-ui leading-relaxed text-fg-dim">
                      <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warn" />
                      <span>{t("settings.claudeOverrideWarn")}</span>
                    </div>
                  )}
                </div>

                {/* Every model default together (audit #51): master (non-UI entry points), worker, then speed — the
                    same order as the Codex sub-tab. */}
                <Section title={t("settings.masterEntrypointModelEffort")} desc={t("settings.masterEntrypointDesc")}>
                  <Row label={t("settings.masterModel")}>
                    <Select className="w-[240px]" value={f.masterModel} onChange={(e) => setF({ ...f, masterModel: e.target.value })}>
                      {claudeModelOptions(f.masterModel, "master")}
                    </Select>
                  </Row>
                  <Row label={t("settings.effort")}>
                    <Select className="w-[240px]" value={f.masterEffort} disabled={!effortSupported(effectiveModel(f.masterModel, "master"))} onChange={(e) => setF({ ...f, masterEffort: e.target.value })}>
                      {EFFORTS.map((ef) => (<option key={ef} value={ef}>{t(effortLabelKey(ef))}</option>))}
                    </Select>
                  </Row>
                </Section>
                <Section title={t("settings.workerModelEffort")} desc={t("settings.workerModelEffortDesc")}>
                  <Row label={t("settings.workerModel")} hint={t("settings.applyNewWorker")}>
                    <Select className="w-[240px]" value={f.workerModel} onChange={(e) => setF({ ...f, workerModel: e.target.value })}>
                      {claudeModelOptions(f.workerModel, "worker")}
                    </Select>
                  </Row>
                  <Row label={t("settings.effort")}>
                    <Select className="w-[240px]" value={f.workerEffort} disabled={!effortSupported(effectiveModel(f.workerModel, "worker"))} onChange={(e) => setF({ ...f, workerEffort: e.target.value })}>
                      {EFFORTS.map((ef) => (<option key={ef} value={ef}>{t(effortLabelKey(ef))}</option>))}
                    </Select>
                  </Row>
                </Section>
                <Section title={t("speed.label")} desc={t("speed.hint")}>
                  <Row label={t("speed.masterDefault")}><SpeedControl variant="field" hideLabel fieldClassName="w-[240px]" speed={f.masterSpeed ?? "standard"} provider="claude" model={effectiveModel(f.masterModel, "master")} allowInherit={false} label={t("speed.masterDefault")} onChange={(speed) => setF({ ...f, masterSpeed: speed ?? "standard" })} /></Row>
                  <Row label={t("speed.workerDefault")}><SpeedControl variant="field" hideLabel fieldClassName="w-[240px]" speed={f.workerSpeed ?? "standard"} provider="claude" model={effectiveModel(f.workerModel, "worker")} allowInherit={false} label={t("speed.workerDefault")} onChange={(speed) => setF({ ...f, workerSpeed: speed ?? "standard" })} /></Row>
                </Section>
                </div>
              );
            })()}

            {modelsProvider === "codex" && (
              <div className="flex flex-col gap-8">
              <Section title={t("settings.codexTitle")} desc={t("settings.codexDesc")}>
                {/* Auth-readiness card — parity with the Claude sub-tab. codexAuthStatus == null → "checking"
                    (don't render a confident "not authenticated" while the probe is still in flight). */}
                {(() => {
                  const a = codexAuthStatus;
                  const checking = a == null; // still probing (transient)
                  const unavailable = a === "unavailable"; // probe couldn't run (codex missing/broken) — not "not authenticated"
                  const st = checking || unavailable ? null : a;
                  const method = st?.method ?? "none";
                  const ready = st?.ready ?? false;
                  const dotCls = checking || unavailable || !ready ? "bg-stop" : method === "api-key" ? "bg-accent" : "bg-pr";
                  const label = checking
                    ? t("settings.checking")
                    : unavailable
                      ? t("settings.codexAuthUnavailable")
                      : method === "chatgpt"
                        ? t("settings.codexMethodChatgpt")
                        : method === "api-key"
                          ? t("settings.codexMethodApiKey")
                          : method === "bedrock"
                            ? t("settings.codexMethodBedrock")
                            : method === "other"
                              ? t("settings.codexMethodOther")
                              : t("settings.codexMethodNone");
                  const desc = unavailable ? t("settings.codexAuthUnavailableDesc") : ready ? t("settings.codexAuthReady") : t("settings.codexAuthNone");
                  return (
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center justify-between gap-3">
                        <span className="flex items-center gap-2 text-body font-medium text-fg">
                          <span className={cn("h-2 w-2 shrink-0 rounded-full", dotCls)} />
                          {label}
                        </span>
                        {st?.hint && <span className="shrink-0 font-mono text-ui text-muted">{st.hint}</span>}
                      </div>
                      {!checking && <p className="text-ui leading-relaxed text-muted">{desc}</p>}
                    </div>
                  );
                })()}

                {/* The masked field can't show "set from a prior session" (the key is write-only), so the
                    placeholder flips to a local saved note after this session's own confirmed save. The readiness
                    card above IS the live "currently authenticated" signal (refetched after a save, see App.tsx). */}
                <WideRow label={t("settings.codexApiKey")} hint={t("settings.codexApiKeyHint")}>
                  <div className="flex gap-2">
                    <Input type="password" className="min-w-0 flex-1" placeholder={codexKeySaved ? t("settings.secretSaved") : "sk-…"} value={codexKey} onChange={(e) => setCodexKey(e.target.value)} />
                    <Button variant="outline" size="md" aria-label={t("settings.codexKeySave")} loading={codexSave.busy} disabled={!codexKey.trim()} onClick={() => codexSave.run(() => p.onSaveCodexKey?.(codexKey.trim()), () => { setCodexKey(""); setCodexKeySaved(true); })}>{t("common.save")}</Button>
                  </div>
                </WideRow>
              </Section>

              <Section title={t("settings.codexModelsTitle")}>
                <Row label={t("settings.codexMasterModel")} hint={t("settings.codexMasterModelHint")}>
                  {codexModelField(f.codexMasterModel, (v) => setF({ ...f, codexMasterModel: v }))}
                </Row>
                <Row label={t("settings.codexWorkerModel")} hint={t("settings.codexWorkerModelHint")}>
                  {codexModelField(f.codexWorkerModel, (v) => setF({ ...f, codexWorkerModel: v }))}
                </Row>
              </Section>

              <Section title={t("speed.label")} desc={t("speed.hint")}>
                <Row label={t("speed.masterDefault")}><SpeedControl variant="field" hideLabel fieldClassName="w-[240px]" speed={f.codexMasterSpeed ?? "standard"} provider="codex" model={f.codexMasterModel} allowInherit={false} label={t("speed.masterDefault")} onChange={(speed) => setF({ ...f, codexMasterSpeed: speed ?? "standard" })} /></Row>
                <Row label={t("speed.workerDefault")}><SpeedControl variant="field" hideLabel fieldClassName="w-[240px]" speed={f.codexWorkerSpeed ?? "standard"} provider="codex" model={f.codexWorkerModel} allowInherit={false} label={t("speed.workerDefault")} onChange={(speed) => setF({ ...f, codexWorkerSpeed: speed ?? "standard" })} /></Row>
                <p className="text-ui leading-relaxed text-muted">{t("speed.budgetEstimated")}</p>
              </Section>

              <Section title={t("settings.advanced")}>
                <WideRow label={t("settings.codexBin")} hint={t("settings.codexBinHint")}>
                  <Input className="font-mono text-ui" value={f.codexBin ?? ""} placeholder="codex" onChange={(e) => setF({ ...f, codexBin: e.target.value })} />
                </WideRow>
                <Row label={t("settings.codexTurnIdleTimeoutMs")} hint={t("settings.codexTurnIdleTimeoutMsHint")}>
                  <Input type="number" className="w-[120px] tabular-nums" value={f.codexTurnIdleTimeoutMs ?? ""} placeholder="0" onChange={(e) => setF({ ...f, codexTurnIdleTimeoutMs: e.target.value })} />
                  <MsHint value={f.codexTurnIdleTimeoutMs || "0"} offKey="settings.msOff" />
                </Row>
                <Row label={t("settings.codexHandshakeTimeoutMs")} hint={t("settings.codexHandshakeTimeoutMsHint")}>
                  <Input type="number" className="w-[120px] tabular-nums" value={f.codexHandshakeTimeoutMs ?? ""} placeholder="30000" onChange={(e) => setF({ ...f, codexHandshakeTimeoutMs: e.target.value })} />
                  <MsHint value={f.codexHandshakeTimeoutMs || "30000"} offKey="settings.msOff" />
                </Row>
              </Section>
              </div>
            )}
              </>
            )}
          </div>
        </div>
        </div>

          {/* The Save bar: pinned under the list so it never scrolls away (audit #93). On Integrations/Capabilities
              (no draft fields) it shows only while edits from another category are unsaved. */}
          {showSaveBar && (
            <div className="flex h-11 shrink-0 items-center gap-2 border-t border-line px-6">
              {dirty && (
                <>
                  <span className="text-ui text-fg-dim">{t("settings.unsavedCount", { count: changed.length })}</span>
                  <Button variant="ghost" size="sm" disabled={saving} onClick={() => setF(toSettingsDraft(p.settings))}>{t("settings.revert")}</Button>
                </>
              )}
              <Button variant="primary" size="sm" className="ml-auto" loading={saving} disabled={!dirty || budgetInvalid} onClick={() => { void save(); }}>{dirty ? t("common.save") : t("common.saved")}</Button>
            </div>
          )}
        </div>
      </div>
      {confirmRegen && (
        <ConfirmDialog
          title={t("settings.mcpRegenerateConfirmTitle")}
          body={t("settings.mcpRegenerateConfirmBody")}
          confirmLabel={t("settings.mcpRegenerate")}
          variant="danger"
          onConfirm={() => p.onRegenerateMcpToken?.()}
          onCancel={() => setConfirmRegen(false)}
        />
      )}
      {pendingLeave && (
        <UnsavedChangesConfirm
          onCancel={() => setPendingLeave(null)}
          onDiscard={() => leave(pendingLeave)}
          onSave={() => { const action = pendingLeave; void save().then((ok) => { if (ok) leave(action); }); }}
        />
      )}
    </>
  );
}

// Unsaved-changes guard shown when the header X is clicked while dirty (audit #18) — the shared ConfirmDialog with its
// middle action (audit #102). Discard closes the page; Save closes it once the save succeeded (a failed save keeps
// the page and its edits, audit #93); Cancel (stay on the page) just dismisses the dialog.
function UnsavedChangesConfirm({ onCancel, onDiscard, onSave }: { onCancel: () => void; onDiscard: () => void; onSave: () => void }): JSX.Element {
  const t = useT();
  return (
    <ConfirmDialog
      title={t("settings.unsavedTitle")}
      body={t("settings.unsavedBody")}
      confirmLabel={t("settings.confirmSave")}
      secondary={{ label: t("settings.confirmDiscard"), onClick: onDiscard }}
      onConfirm={onSave}
      onCancel={onCancel}
    />
  );
}
