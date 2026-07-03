import { useState } from "react";
import type { SettingsValues } from "@daemon/core/settings.js";
import type { SlackStatus } from "@daemon/core/events.js";
import type { IntegrationsStatus } from "@daemon/protocol/messages.js";
import type { AuthStatus } from "@daemon/core/auth-status.js";
import { X } from "lucide-react";
import { Button } from "../ui/button.js";
import { UpdateSettings } from "./UpdateSettings.js";
import { Input, Select } from "../ui/input.js";
import { EFFORTS, effortSupported } from "../lib/models.js";
import { useStore } from "../store/store.js";
import { cn } from "../lib/cn.js";
import { useT } from "../i18n/provider.js";
import { usePrefsStore } from "../store/prefs.js";
import type { LocalePref } from "../i18n/types.js";

function Field({ label, hint, children }: { label: string; hint?: string; children: JSX.Element }): JSX.Element {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[12px] font-medium text-fg-dim">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-muted">{hint}</span>}
    </label>
  );
}

type Tab = "general" | "slack" | "claude" | "integration";

// Settings page that occupies the entire main area. As settings grew, it was split into General | Slack | Integration tabs.
export function SettingsPage(p: { settings: SettingsValues; onSave: (next: SettingsValues) => void; onClose: () => void; slack: SlackStatus; onSlackToggle: (enabled: boolean) => void; integrations?: IntegrationsStatus | null; authStatus?: AuthStatus | null; onSaveLinearKey?: (key: string) => void; onSaveSlackTokens?: (bot: string, app: string) => void; onSaveAnthropicKey?: (key: string) => void }): JSX.Element {
  const t = useT();
  const localePref = usePrefsStore((s) => s.localePref);
  const setLocalePref = usePrefsStore((s) => s.setLocalePref);
  const [tab, setTab] = useState<Tab>("general");
  const [f, setF] = useState<SettingsValues>(p.settings);
  const [linKey, setLinKey] = useState("");
  const [slackBot, setSlackBot] = useState("");
  const [slackApp, setSlackApp] = useState("");
  const [anthropicKey, setAnthropicKey] = useState("");
  const models = useStore((s) => s.models); // live model list (initialized from the static fallback if none)
  const dirty = JSON.stringify(f) !== JSON.stringify(p.settings);
  const allowAll = f.slackAllowAll === "1";
  const refuseReply = f.slackRefuseReply === "1";

  // Native folder-picker dialog (preload bridge), same as for worktree/session cwd.
  const pickCwd = async (): Promise<void> => {
    const dir = await window.rookery.pickDirectory();
    if (dir) setF((cur) => ({ ...cur, slackCwd: dir }));
  };
  const pickDefaultCwd = async (): Promise<void> => {
    const dir = await window.rookery.pickDirectory();
    if (dir) setF((cur) => ({ ...cur, defaultSessionCwd: dir }));
  };

  const tabs: Array<{ key: Tab; label: string }> = [
    { key: "general", label: t("settings.tabGeneral") },
    { key: "slack", label: "Slack" },
    { key: "claude", label: "Claude" },
    { key: "integration", label: t("settings.integrations") },
  ];

  return (
    <>
      <div className="drag flex h-11 shrink-0 items-center gap-2 border-b border-line px-5 text-[13px]">
        <span className="shrink-0 select-none font-mono text-[9px] uppercase tracking-[0.16em] text-muted/60">Settings</span>
        <span className="font-semibold tracking-[-0.01em]">{t("settings.title")}</span>
        <button onClick={p.onClose} aria-label={t("settings.close")} className="no-drag ml-auto rounded-md p-1.5 text-muted transition-colors hover:bg-raised hover:text-fg-dim">
          <X size={16} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-6 py-6">
          {/* tab bar */}
          <div
            role="tablist"
            onKeyDown={(e) => {
              if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
              e.preventDefault();
              const keys = tabs.map((x) => x.key);
              const i = keys.indexOf(tab);
              const next = e.key === "ArrowRight" ? keys[(i + 1) % keys.length]! : keys[(i - 1 + keys.length) % keys.length]!;
              setTab(next);
              e.currentTarget.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus();
            }}
            className="mb-6 flex items-center gap-1 border-b border-line"
          >
            {tabs.map((tb) => (
              <button
                key={tb.key}
                role="tab"
                data-tab={tb.key}
                aria-selected={tab === tb.key}
                tabIndex={tab === tb.key ? 0 : -1}
                onClick={() => setTab(tb.key)}
                className={cn(
                  "-mb-px border-b-2 px-3 py-2 text-[12px] font-medium transition-colors",
                  tab === tb.key ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg-dim",
                )}
              >
                {tb.label}
              </button>
            ))}
          </div>

          <div key={tab} role="tabpanel" className="rise-in">
            {tab === "general" && (
              <>
                <section>
                  <h2 className="text-[13px] font-semibold">{t("settings.botName")}</h2>
                  <p className="mt-1 text-[11px] leading-relaxed text-muted">{t("settings.botNameDesc")}</p>
                  <div className="mt-3">
                    <Input value={f.masterName ?? ""} placeholder="rookery" maxLength={64} onChange={(e) => setF({ ...f, masterName: e.target.value })} />
                  </div>
                </section>

                <section className="mt-8">
                  <h2 className="text-[13px] font-semibold">{t("settings.defaultFolder")}</h2>
                  <p className="mt-1 text-[11px] leading-relaxed text-muted">{t("settings.defaultFolderDesc")}</p>
                  <div className="mt-3">
                    <Field label={t("settings.defaultFolderLabel")} hint={t("settings.defaultFolderHint")}>
                      <div className="flex gap-2">
                        <Input className="flex-1" value={f.defaultSessionCwd ?? ""} placeholder={t("settings.defaultFolderPlaceholder")} onChange={(e) => setF({ ...f, defaultSessionCwd: e.target.value })} />
                        <Button variant="outline" size="sm" onClick={pickDefaultCwd}>{t("settings.browse")}</Button>
                      </div>
                    </Field>
                  </div>
                </section>

                <section className="mt-8">
                  <h2 className="text-[13px] font-semibold">{t("settings.workerModelEffort")}</h2>
                  <p className="mt-1 text-[11px] leading-relaxed text-muted">{t("settings.workerModelEffortDesc")}</p>
                  <div className="mt-4 flex flex-col gap-3.5">
                    <div className="grid grid-cols-[1fr_120px] gap-2.5">
                      <Field label={t("settings.workerModel")} hint={t("settings.applyNewWorker")}>
                        <Select size="md" className="w-full" value={f.workerModel} onChange={(e) => setF({ ...f, workerModel: e.target.value })}>
                          {models.map((m) => (<option key={m.id} value={m.id}>{m.label}</option>))}
                          {!models.some((m) => m.id === f.workerModel) && <option value={f.workerModel}>{f.workerModel}</option>}
                        </Select>
                      </Field>
                      <Field label={t("settings.effort")}>
                        <Select size="md" className="w-full" value={f.workerEffort} disabled={!effortSupported(f.workerModel)} onChange={(e) => setF({ ...f, workerEffort: e.target.value })}>
                          {EFFORTS.map((ef) => (<option key={ef} value={ef}>{ef}</option>))}
                        </Select>
                      </Field>
                    </div>
                  </div>
                </section>

                <section className="mt-8">
                  <h2 className="text-[13px] font-semibold">{t("settings.usage")}</h2>
                  <p className="mt-1 text-[11px] leading-relaxed text-muted">{t("settings.usageDesc")}</p>
                  <div className="mt-3 max-w-[220px]">
                    <Field label={t("settings.usageRefreshMs")}>
                      <Input type="number" placeholder="120000" value={f.usageRefreshMs ?? ""} onChange={(e) => setF({ ...f, usageRefreshMs: e.target.value })} />
                    </Field>
                  </div>
                </section>

                <section className="mt-8">
                  <h2 className="text-[13px] font-semibold">{t("settings.language")}</h2>
                  <p className="mt-1 text-[11px] leading-relaxed text-muted">{t("settings.languageDesc")}</p>
                  <div className="mt-3">
                    <Select size="md" className="w-full" value={localePref} onChange={(e) => setLocalePref(e.target.value as LocalePref)}>
                      <option value="system">{t("settings.langSystem")}</option>
                      <option value="ko">한국어</option>
                      <option value="en">English</option>
                    </Select>
                  </div>
                </section>

                <UpdateSettings />
              </>
            )}

            {tab === "slack" && (
              <section>
                <h2 className="text-[13px] font-semibold">Slack</h2>
                <p className="mt-1 text-[11px] leading-relaxed text-muted">{t("settings.slackDesc")}</p>
                <div className="mt-3 flex items-center gap-3 rounded-[var(--radius)] border border-line bg-ink/40 px-3 py-2.5">
                  <span className={cn("h-2 w-2 shrink-0 rounded-full transition-colors duration-200",
                    p.slack === "up" ? "bg-pr" : p.slack === "connecting" ? "bg-run text-run led-live" : p.slack === "error" ? "bg-fail" : "bg-stop")} />
                  <span className="text-[12px] text-fg-dim">
                    {p.slack === "up" ? t("settings.slackUp") : p.slack === "connecting" ? t("settings.slackConnecting") : p.slack === "error" ? t("settings.slackError") : p.slack === "off" ? t("settings.slackOff") : t("settings.slackNoToken")}
                  </span>
                  <button
                    onClick={() => p.onSlackToggle(p.slack === "off")}
                    disabled={p.slack === "unconfigured"}
                    className={cn("ml-auto rounded-full px-3 py-1 text-[11px] font-medium transition-[color,background-color,border-color,transform] duration-150 active:scale-[0.97] motion-reduce:active:scale-100 disabled:opacity-40",
                      p.slack === "off" ? "border border-line text-muted hover:border-accent/40" : "bg-accent/15 text-accent hover:bg-accent/25")}
                  >
                    {p.slack === "off" ? t("settings.toggleOn") : t("settings.toggleOff")}
                  </button>
                </div>
                {p.slack === "unconfigured" && <p className="mt-2 text-[11px] text-muted">{t("settings.slackUnconfigured")}</p>}

                <div className="mt-4 flex flex-col gap-3.5">
                  <p className="text-[11px] leading-relaxed text-muted">{t("settings.slackTokensDesc")}</p>
                  {/* Tokens get a full line each — they're quite long, so a half-width field would cut them off. */}
                  {/* Any status other than "unconfigured" means tokens are already saved (write-only secrets are never echoed
                      back), so the empty xoxb-…/xapp-… hint would misleadingly read as "not set" (audit #41). */}
                  <Field label={t("settings.slackBotToken")}>
                    <Input type="password" placeholder={p.slack !== "unconfigured" ? t("settings.secretSaved") : "xoxb-…"} value={slackBot} onChange={(e) => setSlackBot(e.target.value)} />
                  </Field>
                  <Field label={t("settings.slackAppToken")}>
                    <Input type="password" placeholder={p.slack !== "unconfigured" ? t("settings.secretSaved") : "xapp-…"} value={slackApp} onChange={(e) => setSlackApp(e.target.value)} />
                  </Field>
                  <div className="flex justify-end">
                    <Button variant="outline" size="sm" disabled={!slackBot.trim() || !slackApp.trim()} onClick={() => { p.onSaveSlackTokens?.(slackBot.trim(), slackApp.trim()); setSlackBot(""); setSlackApp(""); }}>{t("settings.slackTokensSave")}</Button>
                  </div>
                  <Field label={t("settings.slackCwd")} hint={t("settings.slackCwdHint")}>
                    <div className="flex gap-2">
                      <Input className="flex-1" value={f.slackCwd ?? ""} onChange={(e) => setF({ ...f, slackCwd: e.target.value })} />
                      <Button variant="outline" size="sm" onClick={pickCwd}>{t("settings.browse")}</Button>
                    </div>
                  </Field>
                  <label className="flex items-center gap-2 select-none">
                    <input type="checkbox" className="accent-accent" checked={allowAll} onChange={(e) => setF({ ...f, slackAllowAll: e.target.checked ? "1" : "0" })} />
                    <span className="text-[12px] text-fg-dim">{t("settings.slackAllowAll")}</span>
                  </label>
                  <Field label={t("settings.slackAllowedUsers")} hint={t("settings.slackAllowedUsersHint")}>
                    {/* When allow-all is on, the allowlist is meaningless → disable the input. */}
                    <Input value={f.slackAllowedUsers ?? ""} placeholder="U123,U456" disabled={allowAll} onChange={(e) => setF({ ...f, slackAllowedUsers: e.target.value })} />
                  </Field>
                  <label className="flex items-center gap-2 select-none">
                    <input type="checkbox" className="accent-accent" checked={refuseReply} onChange={(e) => setF({ ...f, slackRefuseReply: e.target.checked ? "1" : "0" })} />
                    <span className="text-[12px] text-fg-dim">{t("settings.slackRefuseReply")}</span>
                  </label>
                  <Field label={t("settings.slackRefusalMessage")} hint={t("settings.slackRefusalMessageHint")}>
                    {/* When auto-reply is off, disable the message input. */}
                    <Input value={f.slackRefusalMessage ?? ""} disabled={!refuseReply} onChange={(e) => setF({ ...f, slackRefusalMessage: e.target.value })} />
                  </Field>
                  <Field label={t("settings.slackLocale")} hint={t("settings.slackLocaleHint")}>
                    <Select size="md" className="w-full" value={f.slackLocale ?? "ko"} onChange={(e) => setF({ ...f, slackLocale: e.target.value })}>
                      <option value="ko">한국어</option>
                      <option value="en">English</option>
                    </Select>
                  </Field>
                  <label className="flex items-center gap-2 select-none">
                    <input type="checkbox" className="accent-accent" checked={f.workerSlackRelayEnabled === "1"} onChange={(e) => setF({ ...f, workerSlackRelayEnabled: e.target.checked ? "1" : "0" })} />
                    <span className="text-[12px] text-fg-dim">{t("settings.workerRelay")}</span>
                  </label>
                  <p className="-mt-1 text-[11px] leading-relaxed text-muted">{t("settings.workerRelayDesc")}</p>
                  <Field label={t("settings.workerRelayChannel")} hint={t("settings.workerRelayChannelHint")}>
                    <Input value={f.workerSlackRelayChannel ?? ""} placeholder="C0123456789" disabled={f.workerSlackRelayEnabled !== "1"} onChange={(e) => setF({ ...f, workerSlackRelayChannel: e.target.value })} />
                  </Field>
                </div>

                {/* Master default model/effort lives here because the live default only governs non-UI entry points —
                    Slack, the CLI, and automation rules that don't set a model. The desktop chat picks model/effort per session. */}
                <div className="mt-6 border-t border-line pt-5">
                  <h2 className="text-[13px] font-semibold">{t("settings.masterEntrypointModelEffort")}</h2>
                  <p className="mt-1 text-[11px] leading-relaxed text-muted">{t("settings.masterEntrypointDesc")}</p>
                  <div className="mt-4 grid grid-cols-[1fr_120px] gap-2.5">
                    <Field label={t("settings.masterModel")}>
                      <Select size="md" className="w-full" value={f.masterModel} onChange={(e) => setF({ ...f, masterModel: e.target.value })}>
                        {models.map((m) => (<option key={m.id} value={m.id}>{m.label}</option>))}
                        {!models.some((m) => m.id === f.masterModel) && <option value={f.masterModel}>{f.masterModel}</option>}
                      </Select>
                    </Field>
                    <Field label={t("settings.effort")}>
                      <Select size="md" className="w-full" value={f.masterEffort} disabled={!effortSupported(f.masterModel)} onChange={(e) => setF({ ...f, masterEffort: e.target.value })}>
                        {EFFORTS.map((ef) => (<option key={ef} value={ef}>{ef}</option>))}
                      </Select>
                    </Field>
                  </div>
                </div>
              </section>
            )}

            {tab === "integration" && (
              <section>
                <h2 className="text-[13px] font-semibold">{t("settings.integrations")}</h2>
                <p className="mt-1 text-[11px] leading-relaxed text-muted">{t("settings.integrationsDesc")}</p>

                {/* While integrations is still null (loading, or a silently-swallowed request failure), don't assert
                    "auth needed" — that reads as a confident negative when we simply don't know yet (audit #15). */}
                <div className="mt-3 flex items-center gap-3 rounded-[var(--radius)] border border-line bg-ink/40 px-3 py-2.5">
                  <span className={cn("h-2 w-2 shrink-0 rounded-full transition-colors duration-200", p.integrations?.github.available ? "bg-pr" : "bg-stop")} />
                  <span className="text-[12px] text-fg-dim">
                    GitHub (gh CLI){p.integrations?.github.available ? ` · ${p.integrations.github.user ?? t("settings.githubConnected")}` : ""}
                  </span>
                  {!p.integrations ? (
                    <span className="ml-auto text-[11px] text-muted">{t("settings.checking")}</span>
                  ) : !p.integrations.github.available ? (
                    <span className="ml-auto text-[11px] text-muted">{t("settings.ghAuthNeeded")}</span>
                  ) : null}
                </div>

                <div className="mt-2 flex flex-col gap-2 rounded-[var(--radius)] border border-line bg-ink/40 px-3 py-2.5">
                  <div className="flex items-center gap-3">
                    <span className={cn("h-2 w-2 shrink-0 rounded-full transition-colors duration-200", p.integrations?.linear.valid ? "bg-pr" : p.integrations?.linear.configured ? "bg-fail" : "bg-stop")} />
                    <span className="text-[12px] text-fg-dim">
                      Linear{!p.integrations ? ` · ${t("settings.checking")}` : p.integrations.linear.valid ? ` · ${p.integrations.linear.user ?? t("settings.linearConnected")}` : p.integrations.linear.configured ? ` · ${t("settings.linearKeyInvalid")}` : ""}
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <Input
                      type="password"
                      className="flex-1"
                      placeholder={p.integrations?.linear.configured ? t("settings.linearReplace") : t("settings.linearPlaceholder")}
                      value={linKey}
                      onChange={(e) => setLinKey(e.target.value)}
                    />
                    <Button variant="outline" size="sm" disabled={!linKey.trim()} onClick={() => { p.onSaveLinearKey?.(linKey.trim()); setLinKey(""); }}>{t("common.connect")}</Button>
                  </div>
                </div>
              </section>
            )}

            {tab === "claude" && (() => {
              const a = p.authStatus;
              // While authStatus is still null (loading, or a silently-swallowed request failure), don't default to
              // method="none" — that renders a confident "No auth active" even when a key is actually working (audit #15).
              const checking = a == null;
              const method = a?.method ?? "none";
              const dotCls = checking ? "bg-stop" : method === "api-key" ? "bg-accent" : method === "oauth" ? "bg-pr" : "bg-stop";
              const label = checking ? t("settings.checking") : method === "api-key" ? t("settings.claudeMethodApiKey") : method === "oauth" ? t("settings.claudeMethodSubscription") : t("settings.claudeMethodNone");
              const desc = method === "api-key" ? t("settings.claudeApiKeyActive") : method === "oauth" ? t("settings.claudeSubscriptionActive") : t("settings.claudeNoneActive");
              return (
                <section>
                  <h2 className="text-[13px] font-semibold">{t("settings.claudeAuthTitle")}</h2>
                  <p className="mt-1 text-[11px] leading-relaxed text-muted">{t("settings.claudeAuthDesc")}</p>

                  <div className="mt-3 rounded-[var(--radius)] border border-line bg-ink/40 px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className={cn("h-2 w-2 shrink-0 rounded-full", dotCls)} />
                      <span className="text-[13px] font-medium text-fg">{label}</span>
                      {a?.method === "api-key" && a.apiKeyHint && <span className="font-mono text-[11px] text-muted">{a.apiKeyHint}</span>}
                    </div>
                    {!checking && <p className="mt-1 text-[11px] leading-relaxed text-muted">{desc}</p>}
                  </div>

                  {a?.overridesSubscription && (
                    <div className="mt-3 rounded-[var(--radius)] border border-run/40 bg-run/12 px-3 py-2.5 text-[11px] leading-relaxed text-fg-dim">
                      ⚠️ {t("settings.claudeOverrideWarn")}
                    </div>
                  )}

                  <div className="mt-5 flex flex-col gap-3.5">
                    <Field label={t("settings.anthropicApiKey")} hint={t("settings.anthropicApiKeyHint")}>
                      <Input type="password" placeholder="sk-ant-…" value={anthropicKey} onChange={(e) => setAnthropicKey(e.target.value)} />
                    </Field>
                    <div className="flex justify-end">
                      <Button variant="outline" size="sm" disabled={!anthropicKey.trim()} onClick={() => { p.onSaveAnthropicKey?.(anthropicKey.trim()); setAnthropicKey(""); }}>{t("common.save")}</Button>
                    </div>
                  </div>
                </section>
              );
            })()}
          </div>

          {/* Save the General/Slack form settings (tokens/Linear/toggles have their own buttons). Hidden on read-only tabs (Integration, Claude) which have no f-backed fields. */}
          {tab !== "integration" && tab !== "claude" && (
            <div className="mt-7 flex items-center justify-end gap-2 border-t border-line pt-4">
              <Button variant="primary" disabled={!dirty} onClick={() => p.onSave(f)}>{dirty ? t("common.save") : t("common.saved")}</Button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
