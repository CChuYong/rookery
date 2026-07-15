import { useEffect, useMemo, useState } from "react";
import { CircleAlert, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import type {
  CapabilityAgentKind,
  CapabilityBinding,
  CapabilityBindingInput,
  CapabilityLibrarySnapshot,
  CapabilityOrigin,
  CapabilityScopeKind,
} from "@daemon/core/capabilities/types.js";
import { useT } from "../../i18n/provider.js";
import { Button } from "../../ui/button.js";
import type { CapabilityCenterApi, CapabilityTargetOptions } from "./types.js";

export interface CapabilityAssignmentsTabProps {
  api: CapabilityCenterApi;
  generation: number;
  targets: CapabilityTargetOptions;
}

const AGENTS: CapabilityAgentKind[] = ["master", "worker", "side"];
const ORIGINS: CapabilityOrigin[] = ["ui", "slack", "automation", "external"];
const SCOPES: CapabilityScopeKind[] = ["rookery", "repo-local", "repo-shared", "session", "worker"];

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function newBindingId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `binding-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function targetValues(scope: CapabilityScopeKind, targets: CapabilityTargetOptions): Array<{ id: string; label: string }> {
  if (scope === "repo-local" || scope === "repo-shared") return targets.repos;
  if (scope === "session") return targets.sessions;
  if (scope === "worker") return targets.workers;
  return [];
}

function scopeLabel(t: ReturnType<typeof useT>, scope: CapabilityScopeKind): string {
  return t(`capabilities.bindingScope.${scope}`);
}

function audienceLabel(t: ReturnType<typeof useT>, binding: CapabilityBinding): string {
  return `${binding.audience.agents.map((item) => t(`capabilities.agent.${item}`)).join(", ")} · ${binding.audience.origins.map((item) => t(`capabilities.origin.${item}`)).join(", ")}`;
}

export function CapabilityAssignmentsTab({ api, generation, targets }: CapabilityAssignmentsTabProps): JSX.Element {
  const t = useT();
  const [library, setLibrary] = useState<CapabilityLibrarySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [packInstanceId, setPackInstanceId] = useState("");
  const [scopeKind, setScopeKind] = useState<CapabilityScopeKind>("rookery");
  const [scopeRef, setScopeRef] = useState("");
  const [agents, setAgents] = useState<CapabilityAgentKind[]>(["master", "worker"]);
  const [origins, setOrigins] = useState<CapabilityOrigin[]>(["ui"]);
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const reload = async (): Promise<void> => {
    const next = await api.loadLibrary();
    setLibrary(next);
    setError(null);
  };

  useEffect(() => {
    let current = true;
    setLoading(true); setError(null);
    void api.loadLibrary().then(
      (next) => { if (current) { setLibrary(next); setLoading(false); } },
      (cause) => { if (current) { setError(message(cause)); setLoading(false); } },
    );
    return () => { current = false; };
  }, [api, generation, reloadKey]);

  useEffect(() => {
    if (!packInstanceId && library?.packs[0]) setPackInstanceId(library.packs[0].instanceId);
  }, [library, packInstanceId]);

  const scopeTargets = useMemo(() => targetValues(scopeKind, targets), [scopeKind, targets]);

  const resetForm = (): void => {
    setEditingId(null);
    setPackInstanceId(library?.packs[0]?.instanceId ?? "");
    setScopeKind("rookery");
    setScopeRef("");
    setAgents(["master", "worker"]);
    setOrigins(["ui"]);
    setEnabled(true);
    setFormError(null);
  };

  const edit = (binding: CapabilityBinding): void => {
    setEditingId(binding.id);
    setPackInstanceId(binding.packInstanceId);
    setScopeKind(binding.scopeKind);
    setScopeRef(binding.scopeRef);
    setAgents(binding.audience.agents);
    setOrigins(binding.audience.origins);
    setEnabled(binding.enabled);
    setFormError(null);
  };

  const toggle = <T extends string>(values: T[], value: T, setValues: (next: T[]) => void): void => {
    setValues(values.includes(value) ? values.filter((item) => item !== value) : [...values, value]);
  };

  const save = (): void => {
    if (!packInstanceId) { setFormError(t("capabilities.bindingPackRequired")); return; }
    if (agents.length === 0) { setFormError(t("capabilities.bindingAgentRequired")); return; }
    if (origins.length === 0) { setFormError(t("capabilities.bindingOriginRequired")); return; }
    if (scopeKind !== "rookery" && !scopeRef) { setFormError(t("capabilities.bindingTargetRequired")); return; }
    const id = editingId ?? newBindingId();
    const input: CapabilityBindingInput = {
      packInstanceId,
      scopeKind,
      scopeRef: scopeKind === "rookery" ? "" : scopeRef,
      audience: {
        agents: AGENTS.filter((item) => agents.includes(item)),
        origins: ORIGINS.filter((item) => origins.includes(item)),
      },
      enabled,
    };
    setSaving(true); setFormError(null);
    void api.setBinding(id, input).then(async () => { await reload(); resetForm(); })
      .catch((cause) => setFormError(message(cause))).finally(() => setSaving(false));
  };

  if (loading) return <div className="flex justify-center gap-2 py-24 text-[12px] text-muted"><Loader2 size={14} className="animate-spin" /> {t("common.loading")}</div>;
  if (error) return <div className="flex flex-col items-center gap-3 py-20 text-center"><CircleAlert size={26} className="text-fail" /><p className="text-[12px] text-fail">{t("capabilities.assignmentsLoadFailed")}</p><p className="font-mono text-[10.5px] text-muted">{error}</p><Button variant="outline" size="sm" onClick={() => setReloadKey((value) => value + 1)}>{t("common.retry")}</Button></div>;

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.72fr)]">
      <section className="min-w-0">
        <div className="mb-3"><h2 className="text-[14px] font-semibold text-fg">{t("capabilities.assignments")}</h2><p className="mt-1 text-[11px] text-muted">{t("capabilities.assignmentsDescription")}</p></div>
        {library?.bindings.length ? (
          <div className="space-y-2">
            {library.bindings.map((binding) => {
              const pack = library.packs.find((candidate) => candidate.instanceId === binding.packInstanceId);
              return (
                <article key={binding.id} data-testid={`capability-binding-${binding.id}`} className="rounded-[var(--radius)] border border-line bg-surface/40 px-3.5 py-3">
                  <div className="flex flex-wrap items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2"><h3 className="text-[12.5px] font-medium text-fg">{pack?.manifest.displayName ?? binding.packInstanceId}</h3><span className="rounded border border-line px-1.5 py-0.5 text-[10px] text-muted">{binding.enabled ? t("capabilities.bindingEnabled") : t("capabilities.bindingTombstone")}</span></div>
                      <p className="mt-1 text-[10.5px] text-fg-dim">{scopeLabel(t, binding.scopeKind)}{binding.scopeRef ? ` · ${[...targets.repos, ...targets.sessions, ...targets.workers].find((item) => item.id === binding.scopeRef)?.label ?? binding.scopeRef}` : ""}</p>
                      <p className="mt-1 text-[10px] text-muted">{audienceLabel(t, binding)}</p>
                      <p className="mt-1 text-[10px] text-muted">{t("capabilities.bindingInheritance")}</p>
                    </div>
                    <Button variant="ghost" size="iconSm" aria-label={t("capabilities.edit")} onClick={() => edit(binding)}><Pencil size={13} /></Button>
                    {confirmDelete === binding.id ? <><Button variant="danger" size="sm" onClick={() => { setSaving(true); void api.deleteBinding(binding.id).then(reload).then(() => setConfirmDelete(null)).catch((cause) => setFormError(message(cause))).finally(() => setSaving(false)); }}>{t("common.delete")}</Button><Button variant="ghost" size="sm" onClick={() => setConfirmDelete(null)}>{t("common.cancel")}</Button></> : <Button variant="ghost" size="iconSm" aria-label={t("common.delete")} onClick={() => setConfirmDelete(binding.id)}><Trash2 size={13} /></Button>}
                  </div>
                </article>
              );
            })}
          </div>
        ) : <div className="flex flex-col items-center gap-2 py-16 text-center text-muted"><Plus size={25} className="opacity-40" /><p className="text-[12px]">{t("capabilities.assignmentsEmpty")}</p></div>}
      </section>

      <section className="h-fit rounded-[var(--radius)] border border-line bg-surface/45 p-4">
        <h2 className="text-[13px] font-semibold text-fg">{editingId ? t("capabilities.editAssignment") : t("capabilities.newAssignment")}</h2>
        <div className="mt-4 space-y-4">
          <label className="block text-[11px] text-fg-dim">{t("capabilities.pack")}
            <select aria-label={t("capabilities.pack")} value={packInstanceId} onChange={(event) => setPackInstanceId(event.target.value)} className="mt-1 w-full rounded-md border border-line bg-base px-2.5 py-2 text-[11.5px] text-fg">
              <option value="">{t("capabilities.select")}</option>
              {library?.packs.map((pack) => <option key={pack.instanceId} value={pack.instanceId}>{pack.manifest.displayName}</option>)}
            </select>
          </label>
          <label className="block text-[11px] text-fg-dim">{t("capabilities.bindingScope")}
            <select aria-label={t("capabilities.bindingScope")} value={scopeKind} onChange={(event) => { const next = event.target.value as CapabilityScopeKind; setScopeKind(next); setScopeRef(""); }} className="mt-1 w-full rounded-md border border-line bg-base px-2.5 py-2 text-[11.5px] text-fg">
              {SCOPES.map((scope) => <option key={scope} value={scope}>{scopeLabel(t, scope)}</option>)}
            </select>
          </label>
          {scopeKind !== "rookery" && <label className="block text-[11px] text-fg-dim">{t("capabilities.bindingTarget")}
            <select aria-label={t("capabilities.bindingTarget")} value={scopeRef} onChange={(event) => setScopeRef(event.target.value)} className="mt-1 w-full rounded-md border border-line bg-base px-2.5 py-2 text-[11.5px] text-fg"><option value="">{t("capabilities.select")}</option>{scopeTargets.map((target) => <option key={target.id} value={target.id}>{target.label}</option>)}</select>
          </label>}
          <fieldset><legend className="text-[11px] text-fg-dim">{t("capabilities.bindingAgents")}</legend><div className="mt-2 flex flex-wrap gap-3">{AGENTS.map((agent) => <label key={agent} className="flex items-center gap-1.5 text-[11px] text-fg-dim"><input type="checkbox" checked={agents.includes(agent)} onChange={() => toggle(agents, agent, setAgents)} />{t(`capabilities.agent.${agent}`)}</label>)}</div></fieldset>
          <fieldset><legend className="text-[11px] text-fg-dim">{t("capabilities.bindingOrigins")}</legend><div className="mt-2 flex flex-wrap gap-3">{ORIGINS.map((origin) => <label key={origin} className="flex items-center gap-1.5 text-[11px] text-fg-dim"><input type="checkbox" checked={origins.includes(origin)} onChange={() => toggle(origins, origin, setOrigins)} />{t(`capabilities.origin.${origin}`)}</label>)}</div></fieldset>
          <label className="flex items-start gap-2 rounded-md border border-line bg-base/40 p-2.5 text-[11px] text-fg-dim"><input type="checkbox" checked={!enabled} onChange={(event) => setEnabled(!event.target.checked)} /><span><strong className="font-medium text-fg">{t("capabilities.bindingTombstone")}</strong><span className="mt-0.5 block text-[10px] text-muted">{t("capabilities.bindingTombstoneDescription")}</span></span></label>
          {formError && <p className="text-[11px] text-fail">{formError}</p>}
          <div className="flex justify-end gap-2">{editingId && <Button variant="ghost" size="sm" onClick={resetForm}>{t("common.cancel")}</Button>}<Button variant="primary" size="sm" loading={saving} onClick={save}>{editingId ? t("common.save") : t("capabilities.createAssignment")}</Button></div>
        </div>
      </section>
    </div>
  );
}
