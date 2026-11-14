import { useEffect, useRef, useState, type ReactNode } from "react";
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
import { useDismissTransition } from "../lib/useDismissTransition.js";
import { useModalKeys } from "../lib/useModalKeys.js";
import { useFocusTrap } from "../lib/useFocusTrap.js";
import { CapabilityScopeBindings } from "./capabilities/CapabilityScopeBindings.js";
import type { CapabilityCenterApi } from "./capabilities/types.js";

// VS Code settings composition: a section title with a hairline rule under it, then plain stacked settings —
// no wells/cards. `Row` is the compact form (label+hint left, control right, e.g. a select or a short input);
// `WideRow` puts the label on its own line above a full-width control (paths, tokens, allowlists, the MCP URL —
// anything that would overflow a right-aligned slot). Both wrap the row in a <label> so the control keeps its
// implicit accessible name (getByLabelText parity with the old Field component); status-only rows (no control)
// use a plain <div> instead via `StatusRow`. The 20px rhythm between settings comes from the section's own gap.
function Section({ title, desc, children }: { title: string; desc?: string; children: ReactNode }): JSX.Element {
  return (
    <section>
      <h2 className="pb-1 text-body font-semibold text-fg">{title}</h2>
      {desc && <p className="mt-2 max-w-[70ch] text-ui leading-relaxed text-muted">{desc}</p>}
      <div className="mt-3 flex flex-col gap-5">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <label className="flex items-center justify-between gap-6">
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-body font-medium text-fg">{label}</span>
        {hint && <span className="max-w-[70ch] text-ui leading-relaxed text-muted">{hint}</span>}
      </span>
      <span className="flex shrink-0 items-center gap-2">{children}</span>
    </label>
  );
}

function WideRow({ label, hint, children }: { label?: ReactNode; hint?: ReactNode; children: ReactNode }): JSX.Element {
  // No label → this is a plain content row (e.g. a status line + its own control), not a form field, so it's a
  // <div> rather than a <label> (nothing to implicitly associate a control with).
  const Tag = label ? "label" : "div";
  return (
    <Tag className="flex flex-col items-stretch gap-2">
      {label && (
        <span className="flex flex-col gap-0.5">
          <span className="text-body font-medium text-fg">{label}</span>
          {hint && <span className="max-w-[70ch] text-ui leading-relaxed text-muted">{hint}</span>}
        </span>
      )}
      {children}
    </Tag>
  );
}

function StatusRow({ children }: { children: ReactNode }): JSX.Element {
  return <div className="flex items-center gap-3">{children}</div>;
}

type Tab = "general" | "slack" | "models" | "capabilities" | "integration";
type ModelsProvider = "claude" | "codex";

// Settings page that occupies the entire main area. As settings grew, it was split into General | Slack | Claude | Codex | Integration tabs.
export function SettingsPage(p: { settings: SettingsValues; onSave: (next: SettingsValues) => void; onClose: () => void; slack: SlackStatus; onSlackToggle: (enabled: boolean) => void; integrations?: IntegrationsStatus | null; authStatus?: AuthStatus | null; onSaveLinearKey?: (key: string) => void; onSaveSlackTokens?: (bot: string, app: string) => void; onSaveAnthropicKey?: (key: string) => void; onSaveCodexKey?: (key: string) => void; mcpStatus?: { scope: "off" | "readonly" | "full"; url: string | null } | null; onRegenerateMcpToken?: () => void; capabilityApi?: CapabilityCenterApi; capabilityGeneration?: number; onOpenCapabilityCatalog?: () => void; onOpenCapabilityAssignments?: () => void; onPreviewCapabilities?: () => void }): JSX.Element {
  const t = useT();
  const localePref = usePrefsStore((s) => s.localePref);
  const setLocalePref = usePrefsStore((s) => s.setLocalePref);
  const [tab, setTab] = useState<Tab>("general");
  // Which provider's config the "Models" tab shows — a pill sub-toggle inside that tab. Ephemeral
  // (defaults to Claude each open), matching the top-level `tab`'s non-persisted behavior.
  const [modelsProvider, setModelsProvider] = useState<ModelsProvider>("claude");
  const [f, setF] = useState<SettingsValues>(p.settings);
  const [linKey, setLinKey] = useState("");
  const [slackBot, setSlackBot] = useState("");
  const [slackApp, setSlackApp] = useState("");
  const [anthropicKey, setAnthropicKey] = useState("");
  const [codexKey, setCodexKey] = useState("");
  // Codex has no auth-status probe (unlike Anthropic's live check above) — this local flag is the only signal
  // that a key was saved this session, driving the same "saved" placeholder idiom the slack token fields use.
  const [codexKeySaved, setCodexKeySaved] = useState(false);
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
  const dirty = JSON.stringify(f) !== JSON.stringify(p.settings);
  const allowAll = f.slackAllowAll === "1";
  const refuseReply = f.slackRefuseReply === "1";

  // Explicit-Save page + no auto-save → closing while dirty silently discarded edits (audit #18). Gate the page's own
  // close affordance (the header X) behind a confirm when dirty; not dirty closes exactly as before. Out of scope:
  // intercepting sidebar navigation away from the page — only this in-page close action.
  const [confirmClose, setConfirmClose] = useState(false);
  const [mcpCopied, setMcpCopied] = useState(false);
  const copyMcpUrl = (url: string): void => {
    void navigator.clipboard.writeText(url).then(() => { setMcpCopied(true); window.setTimeout(() => setMcpCopied(false), 1500); }).catch(() => {});
  };
  const requestClose = (): void => {
    if (dirty) setConfirmClose(true);
    else p.onClose();
  };

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

  return (
    <>
      <div className="drag flex h-10 shrink-0 items-center gap-2 px-5">
        <span className="text-body font-medium text-fg">{t("settings.title")}</span>
        <Button variant="ghost" size="iconSm" className="no-drag ml-auto" onClick={requestClose} aria-label={t("settings.close")}>
          <X size={14} />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1">
        {/* category rail — VS Code settings layout: a left list of categories (not tabs-as-pills), driven by
            the same tab state/handlers the old horizontal Segment used. */}
        <nav role="tablist" aria-label={t("settings.title")} className="w-[180px] shrink-0 overflow-y-auto bg-sunk py-2">
          {tabs.map((item) => (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={tab === item.value}
              onClick={() => setTab(item.value)}
              className={cn(
                "flex h-[26px] w-full items-center px-3 text-left text-body transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent-hi",
                tab === item.value ? "bg-raised text-fg" : "text-muted hover:bg-raised/60 hover:text-fg-dim",
              )}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={cn("px-8 py-6", tab === "capabilities" ? "max-w-[880px]" : "max-w-[720px]")}>
          <div key={tab} role="tabpanel" className="rise-in">
            {tab === "general" && (
              <div className="flex flex-col gap-8">
                <Section title={t("settings.botName")} desc={t("settings.botNameDesc")}>
                  <Row label={t("settings.botName")}>
                    <Input className="w-[240px]" value={f.masterName ?? ""} placeholder="rookery" maxLength={64} onChange={(e) => setF({ ...f, masterName: e.target.value })} />
                  </Row>
                </Section>

                <Section title={t("settings.defaultFolder")} desc={t("settings.defaultFolderDesc")}>
                  <WideRow label={t("settings.defaultFolderLabel")} hint={t("settings.defaultFolderHint")}>
                    <div className="flex gap-2">
                      <Input className="min-w-0 flex-1 font-mono text-ui" value={f.defaultSessionCwd ?? ""} placeholder={t("settings.defaultFolderPlaceholder")} onChange={(e) => setF({ ...f, defaultSessionCwd: e.target.value })} />
                      <Button variant="outline" size="sm" onClick={pickDefaultCwd}>{t("settings.browse")}</Button>
                    </div>
                  </WideRow>
                </Section>

                {/* Worker model/effort defaults moved to Models → per provider. The cost budget is
                    provider-agnostic (applies to Claude AND Codex workers), so it stays here in General. */}
                <Section title={t("settings.workerBudget")}>
                  <Row label={t("settings.workerCostBudgetUsd")} hint={t("settings.workerCostBudgetUsdHint")}>
                    <Input type="number" className="w-[120px] tabular-nums" value={f.workerCostBudgetUsd ?? ""} placeholder="off" onChange={(e) => setF({ ...f, workerCostBudgetUsd: e.target.value })} />
                  </Row>
                </Section>

                {/* External MCP server (rookery-as-MCP): expose fleet control to external MCP clients (Claude Code /
                    Cursor / Codex). Off by default (fail-closed). The scope is f-backed (saved via the footer button);
                    the URL/token are live actions reflecting the SAVED state (mcpStatus). */}
                <div>
                  <Section title={t("settings.mcpTitle")} desc={t("settings.mcpDesc")}>
                    <Row label={t("settings.mcpExposureLabel")} hint={t("settings.mcpExposureHint")}>
                      <Select className="w-[180px]" value={f.mcpExposure ?? "off"} onChange={(e) => setF({ ...f, mcpExposure: e.target.value })}>
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
                            <Button variant="outline" size="sm" onClick={() => copyMcpUrl(p.mcpStatus!.url!)}>{mcpCopied ? t("settings.mcpCopied") : t("settings.mcpCopy")}</Button>
                          </div>
                          <div className="flex justify-end">
                            <Button variant="outline" size="sm" onClick={() => p.onRegenerateMcpToken?.()}>{t("settings.mcpRegenerate")}</Button>
                          </div>
                        </WideRow>
                      ) : (
                        <div className="text-ui leading-relaxed text-muted">{t("settings.mcpSaveToActivate")}</div>
                      )
                    )}
                  </Section>
                  {f.mcpExposure === "full" && (
                    <div className="mt-2 flex items-start gap-2 rounded-md border border-fail/30 bg-fail/5 px-3 py-2 text-ui leading-relaxed text-fg-dim">
                      <AlertTriangle size={14} className="mt-0.5 shrink-0 text-fail" />
                      <span>{t("settings.mcpFullWarning")}</span>
                    </div>
                  )}
                </div>

                <Section title={t("settings.usage")} desc={t("settings.usageDesc")}>
                  <Row label={t("settings.usageRefreshMs")}>
                    <Input type="number" className="w-[120px] tabular-nums" placeholder="120000" value={f.usageRefreshMs ?? ""} onChange={(e) => setF({ ...f, usageRefreshMs: e.target.value })} />
                  </Row>
                </Section>

                <Section title={t("settings.language")} desc={t("settings.languageDesc")}>
                  <Row label={t("settings.language")}>
                    <Select className="w-[180px]" value={localePref} onChange={(e) => setLocalePref(e.target.value as LocalePref)}>
                      <option value="system">{t("settings.langSystem")}</option>
                      <option value="ko">한국어</option>
                      <option value="en">English</option>
                    </Select>
                  </Row>
                </Section>

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
                    <button
                      onClick={handleSlackToggle}
                      disabled={p.slack === "unconfigured" || slackToggleBusy}
                      aria-busy={slackToggleBusy || undefined}
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
                  <div className="flex justify-end">
                    <Button variant="outline" size="sm" disabled={!slackBot.trim() || !slackApp.trim()} onClick={() => { p.onSaveSlackTokens?.(slackBot.trim(), slackApp.trim()); setSlackBot(""); setSlackApp(""); }}>{t("settings.slackTokensSave")}</Button>
                  </div>
                  <WideRow label={t("settings.slackCwd")} hint={t("settings.slackCwdHint")}>
                    <div className="flex gap-2">
                      <Input className="min-w-0 flex-1 font-mono text-ui" value={f.slackCwd ?? ""} onChange={(e) => setF({ ...f, slackCwd: e.target.value })} />
                      <Button variant="outline" size="sm" onClick={pickCwd}>{t("settings.browse")}</Button>
                    </div>
                  </WideRow>
                  <Row label={t("settings.slackAllowAll")}>
                    <input type="checkbox" className="accent-fg-dim" checked={allowAll} onChange={(e) => setF({ ...f, slackAllowAll: e.target.checked ? "1" : "0" })} />
                  </Row>
                  {/* When allow-all is on, the allowlist is meaningless → disable the input. */}
                  <WideRow label={t("settings.slackAllowedUsers")} hint={t("settings.slackAllowedUsersHint")}>
                    <Input className="font-mono text-ui" value={f.slackAllowedUsers ?? ""} placeholder="U123,U456" disabled={allowAll} onChange={(e) => setF({ ...f, slackAllowedUsers: e.target.value })} />
                  </WideRow>
                  <Row label={t("settings.slackRefuseReply")}>
                    <input type="checkbox" className="accent-fg-dim" checked={refuseReply} onChange={(e) => setF({ ...f, slackRefuseReply: e.target.checked ? "1" : "0" })} />
                  </Row>
                  {/* When auto-reply is off, disable the message input. */}
                  <Row label={t("settings.slackRefusalMessage")} hint={t("settings.slackRefusalMessageHint")}>
                    <Input className="w-[240px]" value={f.slackRefusalMessage ?? ""} disabled={!refuseReply} onChange={(e) => setF({ ...f, slackRefusalMessage: e.target.value })} />
                  </Row>
                  <Row label={t("settings.slackLocale")} hint={t("settings.slackLocaleHint")}>
                    <Select className="w-[180px]" value={f.slackLocale ?? "ko"} onChange={(e) => setF({ ...f, slackLocale: e.target.value })}>
                      <option value="ko">한국어</option>
                      <option value="en">English</option>
                    </Select>
                  </Row>
                  <Row label={t("settings.slackProvider")} hint={t("settings.slackProviderHint")}>
                    <Select className="w-[180px]" value={f.slackProvider ?? "claude"} onChange={(e) => setF({ ...f, slackProvider: e.target.value })}>
                      <option value="claude">{t("workerSpawnModal.providerClaude")}</option>
                      <option value="codex">{t("workerSpawnModal.providerCodex")}</option>
                    </Select>
                  </Row>
                  <Row label={t("settings.workerRelay")} hint={t("settings.workerRelayDesc")}>
                    <input type="checkbox" className="accent-fg-dim" checked={f.workerSlackRelayEnabled === "1"} onChange={(e) => setF({ ...f, workerSlackRelayEnabled: e.target.checked ? "1" : "0" })} />
                  </Row>
                  <WideRow label={t("settings.workerRelayChannel")} hint={t("settings.workerRelayChannelHint")}>
                    <Input className="font-mono text-ui" value={f.workerSlackRelayChannel ?? ""} placeholder="C0123456789" disabled={f.workerSlackRelayEnabled !== "1"} onChange={(e) => setF({ ...f, workerSlackRelayChannel: e.target.value })} />
                  </WideRow>
                </Section>

                {/* Master default model/effort lives here because the live default only governs non-UI entry points —
                    Slack, the CLI, and automation rules that don't set a model. The desktop chat picks model/effort per session. */}
                <Section title={t("settings.masterEntrypointModelEffort")} desc={t("settings.masterEntrypointDesc")}>
                  <Row label={t("settings.masterModel")}>
                    <Select className="w-[180px]" value={f.masterModel} onChange={(e) => setF({ ...f, masterModel: e.target.value })}>
                      {models.map((m) => (<option key={m.id} value={m.id}>{m.label}</option>))}
                      {!models.some((m) => m.id === f.masterModel) && <option value={f.masterModel}>{f.masterModel}</option>}
                    </Select>
                  </Row>
                  <Row label={t("settings.effort")}>
                    <Select className="w-[180px]" value={f.masterEffort} disabled={!effortSupported(f.masterModel)} onChange={(e) => setF({ ...f, masterEffort: e.target.value })}>
                      {EFFORTS.map((ef) => (<option key={ef} value={ef}>{t(effortLabelKey(ef))}</option>))}
                    </Select>
                  </Row>
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
                  {!p.integrations ? (
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
                          ? t("settings.checking")
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
                    <Button variant="outline" size="sm" disabled={!linKey.trim()} onClick={() => { p.onSaveLinearKey?.(linKey.trim()); setLinKey(""); }}>{t("common.connect")}</Button>
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
                onOpenCatalog={p.onOpenCapabilityCatalog ?? (() => {})}
                onOpenAdvancedAssignments={p.onOpenCapabilityAssignments ?? (() => {})}
                onPreviewEffective={p.onPreviewCapabilities ?? (() => {})}
              />
            )}

            {tab === "models" && (
              <>
                {/* pill sub-toggle (in-form selection) — visually distinct from the nav-tier underline tabs above */}
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
              const method = a?.method ?? "none";
              const dotCls = checking ? "bg-stop" : method === "api-key" ? "bg-accent" : method === "oauth" ? "bg-pr" : "bg-stop";
              const label = checking ? t("settings.checking") : method === "api-key" ? t("settings.claudeMethodApiKey") : method === "oauth" ? t("settings.claudeMethodSubscription") : t("settings.claudeMethodNone");
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
                      </div>
                      {!checking && <p className="text-ui leading-relaxed text-muted">{desc}</p>}
                    </div>
                    <WideRow label={t("settings.anthropicApiKey")} hint={t("settings.anthropicApiKeyHint")}>
                      <Input type="password" placeholder="sk-ant-…" value={anthropicKey} onChange={(e) => setAnthropicKey(e.target.value)} />
                    </WideRow>
                    <div className="flex justify-end">
                      <Button variant="outline" size="sm" disabled={!anthropicKey.trim()} onClick={() => { p.onSaveAnthropicKey?.(anthropicKey.trim()); setAnthropicKey(""); }}>{t("common.save")}</Button>
                    </div>
                  </Section>
                  {a?.overridesSubscription && (
                    <div className="mt-2 flex items-start gap-2 rounded-md border border-fail/30 bg-fail/5 px-3 py-2.5 text-ui leading-relaxed text-fg-dim">
                      <AlertTriangle size={14} className="mt-0.5 shrink-0 text-fail" />
                      <span>{t("settings.claudeOverrideWarn")}</span>
                    </div>
                  )}
                </div>

                {/* Claude worker defaults — moved from General so the Claude sub-tab is provider-complete. */}
                <Section title={t("settings.workerModelEffort")} desc={t("settings.workerModelEffortDesc")}>
                  <Row label={t("settings.workerModel")} hint={t("settings.applyNewWorker")}>
                    <Select className="w-[180px]" value={f.workerModel} onChange={(e) => setF({ ...f, workerModel: e.target.value })}>
                      {models.map((m) => (<option key={m.id} value={m.id}>{m.label}</option>))}
                      {!models.some((m) => m.id === f.workerModel) && <option value={f.workerModel}>{f.workerModel}</option>}
                    </Select>
                  </Row>
                  <Row label={t("settings.effort")}>
                    <Select className="w-[180px]" value={f.workerEffort} disabled={!effortSupported(f.workerModel)} onChange={(e) => setF({ ...f, workerEffort: e.target.value })}>
                      {EFFORTS.map((ef) => (<option key={ef} value={ef}>{t(effortLabelKey(ef))}</option>))}
                    </Select>
                  </Row>
                </Section>
                </div>
              );
            })()}

            {modelsProvider === "codex" && (
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

                <WideRow label={t("settings.codexBin")} hint={t("settings.codexBinHint")}>
                  <Input className="font-mono text-ui" value={f.codexBin ?? ""} placeholder="codex" onChange={(e) => setF({ ...f, codexBin: e.target.value })} />
                </WideRow>
                <Row label={t("settings.codexWorkerModel")} hint={t("settings.codexWorkerModelHint")}>
                  {codexModels != null ? (
                    <Select className="w-[180px]" value={f.codexWorkerModel ?? ""} onChange={(e) => setF({ ...f, codexWorkerModel: e.target.value })}>
                      <option value="">{t("settings.codexModelDefaultOption")}</option>
                      {codexModels.map((m) => (
                        <option key={m.id} value={m.id}>{m.displayName}</option>
                      ))}
                      {f.codexWorkerModel && !codexModels.some((m) => m.id === f.codexWorkerModel) && (
                        <option value={f.codexWorkerModel}>{f.codexWorkerModel}</option>
                      )}
                    </Select>
                  ) : (
                    <Input className="w-[240px]" value={f.codexWorkerModel ?? ""} placeholder="gpt-6.1-sol" onChange={(e) => setF({ ...f, codexWorkerModel: e.target.value })} />
                  )}
                </Row>
                <Row label={t("settings.codexMasterModel")} hint={t("settings.codexMasterModelHint")}>
                  {codexModels != null ? (
                    <Select className="w-[180px]" value={f.codexMasterModel ?? ""} onChange={(e) => setF({ ...f, codexMasterModel: e.target.value })}>
                      <option value="">{t("settings.codexModelDefaultOption")}</option>
                      {codexModels.map((m) => (
                        <option key={m.id} value={m.id}>{m.displayName}</option>
                      ))}
                      {f.codexMasterModel && !codexModels.some((m) => m.id === f.codexMasterModel) && (
                        <option value={f.codexMasterModel}>{f.codexMasterModel}</option>
                      )}
                    </Select>
                  ) : (
                    <Input className="w-[240px]" value={f.codexMasterModel ?? ""} placeholder="gpt-6.1-sol" onChange={(e) => setF({ ...f, codexMasterModel: e.target.value })} />
                  )}
                </Row>
                <Row label={t("settings.codexTurnIdleTimeoutMs")} hint={t("settings.codexTurnIdleTimeoutMsHint")}>
                  <Input type="number" className="w-[120px] tabular-nums" value={f.codexTurnIdleTimeoutMs ?? ""} placeholder="0" onChange={(e) => setF({ ...f, codexTurnIdleTimeoutMs: e.target.value })} />
                </Row>
                <Row label={t("settings.codexHandshakeTimeoutMs")} hint={t("settings.codexHandshakeTimeoutMsHint")}>
                  <Input type="number" className="w-[120px] tabular-nums" value={f.codexHandshakeTimeoutMs ?? ""} placeholder="30000" onChange={(e) => setF({ ...f, codexHandshakeTimeoutMs: e.target.value })} />
                </Row>

                {/* The masked field can't show "set from a prior session" (the key is write-only), so the
                    placeholder flips to a local saved note after this session's own save. The readiness card
                    above IS the live "currently authenticated" signal (refetched after a save, see App.tsx). */}
                <WideRow label={t("settings.codexApiKey")} hint={t("settings.codexApiKeyHint")}>
                  <Input type="password" placeholder={codexKeySaved ? t("settings.secretSaved") : "sk-…"} value={codexKey} onChange={(e) => setCodexKey(e.target.value)} />
                </WideRow>
                <div className="flex justify-end">
                  <Button variant="outline" size="sm" disabled={!codexKey.trim()} onClick={() => { p.onSaveCodexKey?.(codexKey.trim()); setCodexKey(""); setCodexKeySaved(true); }}>{t("common.save")}</Button>
                </div>
              </Section>
            )}
              </>
            )}
          </div>

          {/* Save the General/Slack/Models form settings (tokens/Linear/toggles have their own buttons). Hidden only
              on the Integration tab, which has no f-backed fields. (Models is now f-backed: Claude worker model/effort
              + all codex fields; the Anthropic/Codex API keys keep their own save buttons.) */}
          {tab !== "integration" && tab !== "capabilities" && (
            <div className="mt-7 flex items-center justify-end gap-2 border-t border-line pt-4">
              <Button variant="primary" disabled={!dirty} onClick={() => p.onSave(f)}>{dirty ? t("common.save") : t("common.saved")}</Button>
            </div>
          )}
        </div>
        </div>
      </div>
      {confirmClose && (
        <UnsavedChangesConfirm
          onCancel={() => setConfirmClose(false)}
          onDiscard={p.onClose}
          onSave={() => { p.onSave(f); p.onClose(); }}
        />
      )}
    </>
  );
}

// Unsaved-changes guard shown when the header X is clicked while dirty (audit #18) — same overlay/panel idiom as the
// app's other confirm dialogs (AutomationPage's AutomationDeleteConfirm / Sessions' DeleteConfirm). Discard/Save both
// close the whole page, so they fire directly rather than routing through the local exit-transition; Cancel (stay on
// the page) uses `dismiss()` for the dialog's own animated exit.
function UnsavedChangesConfirm({ onCancel, onDiscard, onSave }: { onCancel: () => void; onDiscard: () => void; onSave: () => void }): JSX.Element {
  const t = useT();
  const panelRef = useRef<HTMLDivElement>(null);
  const { closing, dismiss } = useDismissTransition(onCancel);
  useModalKeys({ escape: "close", onEscape: dismiss, onSubmit: onSave });
  useFocusTrap(panelRef);
  return (
    <div className={cn("fixed inset-0 z-[110] flex items-center justify-center bg-scrim", closing ? "motion-safe:animate-[overlay-out_130ms_ease-in]" : "motion-safe:animate-[overlay-in_140ms_ease-out]")}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label={t("settings.unsavedTitle")} className={cn("w-[380px] rounded-xl border border-line bg-surface p-5 shadow-pop", closing ? "motion-safe:animate-[dialog-out_140ms_ease-in]" : "motion-safe:animate-[dialog-in_160ms_ease-out]")}>
        <div className="mb-1.5 text-title font-medium">{t("settings.unsavedTitle")}</div>
        <p className="text-ui leading-relaxed text-muted">{t("settings.unsavedBody")}</p>
        <div className="mt-4 flex justify-end gap-2">
          <button autoFocus onClick={dismiss} className="rounded-lg border border-line px-3 py-1.5 text-ui text-muted hover:bg-raised hover:text-fg-dim">{t("common.cancel")}</button>
          <Button variant="outline" size="sm" onClick={onDiscard}>{t("settings.confirmDiscard")}</Button>
          <Button variant="primary" size="sm" onClick={onSave}>{t("settings.confirmSave")}</Button>
        </div>
      </div>
    </div>
  );
}
