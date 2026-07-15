import { useEffect, useMemo, useState } from "react";
import { Cable, CircleAlert, Loader2, Search, ShieldAlert, Sparkles } from "lucide-react";
import type {
  CapabilityLibraryEntry,
  CapabilityLibrarySnapshot,
  CapabilityQuickBindingMode,
} from "@daemon/core/capabilities/types.js";
import { useT } from "../../i18n/provider.js";
import { Button } from "../../ui/button.js";
import { Input, Select } from "../../ui/input.js";
import { catalogKind, catalogSearchText } from "./catalog.js";
import { capabilityScopeState, repositoryCapabilityInheritance, type CapabilityScopeState } from "./capability-scope-state.js";
import type { CapabilityCenterApi } from "./types.js";

type ManagedScopeKind = "rookery" | "repo-local";

export interface CapabilityScopeBindingsProps {
  scopeKind: ManagedScopeKind;
  scopeRef: string;
  api: CapabilityCenterApi;
  generation: number;
  onOpenCatalog(): void;
  onOpenAdvancedAssignments(): void;
  onPreviewEffective(): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function agentsLabel(agents: Array<"master" | "worker">, t: ReturnType<typeof useT>): string {
  return agents.map((agent) => t(`capabilities.agent.${agent}`)).join(" · ");
}

function inheritanceText(
  direct: CapabilityScopeState,
  pack: CapabilityLibraryEntry,
  library: CapabilityLibrarySnapshot,
  scopeKind: ManagedScopeKind,
  t: ReturnType<typeof useT>,
): string | null {
  if (scopeKind === "rookery") {
    return direct.mode === "inherit" && !direct.custom ? t("settings.capabilitiesNotSetHint") : null;
  }
  if (direct.custom) return null;
  if (direct.mode !== "inherit") return t("repositorySettings.directOverride");
  const inherited = repositoryCapabilityInheritance(library.bindings, pack.instanceId);
  if (inherited.custom) return t("repositorySettings.inheritedCustom");
  if (inherited.mode === "inherit") return t("repositorySettings.noRookeryDefault");
  return t("repositorySettings.inheritedDefault", {
    mode: t(`repositorySettings.mode.${inherited.mode}`),
    agents: agentsLabel(inherited.agents, t),
  });
}

interface CapabilityRowProps {
  pack: CapabilityLibraryEntry;
  library: CapabilityLibrarySnapshot;
  scopeKind: ManagedScopeKind;
  scopeRef: string;
  state: CapabilityScopeState;
  api: CapabilityCenterApi;
  onSaved(): Promise<void>;
  onOpenAdvancedAssignments(): void;
}

function CapabilityRow({ pack, library, scopeKind, scopeRef, state, api, onSaved, onOpenAdvancedAssignments }: CapabilityRowProps): JSX.Element {
  const t = useT();
  const kind = catalogKind(pack);
  const [mode, setMode] = useState<CapabilityQuickBindingMode>(state.mode);
  const [agents, setAgents] = useState<Array<"master" | "worker">>(state.agents);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const missingSecrets = pack.secrets.filter((secret) => !secret.configured).length;
  const prefix = scopeKind === "rookery" ? "rookery" : "repository";
  const hint = inheritanceText(state, pack, library, scopeKind, t);

  useEffect(() => {
    setMode(state.mode);
    setAgents(state.agents);
    setError(null);
  }, [state.mode, state.custom, state.agents.join(":")]);

  const toggleAgent = (agent: "master" | "worker", checked: boolean): void => {
    setAgents((current) => checked
      ? [...current.filter((item) => item !== agent), agent]
      : current.filter((item) => item !== agent));
  };
  const save = (): void => {
    if (mode !== "inherit" && agents.length === 0) {
      setError(t("repositorySettings.agentRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    void api.quickSetBinding({
      packInstanceId: pack.instanceId,
      scopeKind,
      scopeRef,
      mode,
      agents: mode === "inherit" ? [] : agents,
    }).then(onSaved).catch((cause) => setError(errorMessage(cause))).finally(() => setBusy(false));
  };

  return (
    <article data-testid={`${prefix}-capability-${pack.instanceId}`} className="rounded-lg border border-line bg-surface/45 p-4">
      <div className="flex flex-wrap items-start gap-3">
        <span className="mt-0.5 rounded-md border border-line bg-raised p-2 text-pr">{kind === "mcp" ? <Cable size={15} /> : <Sparkles size={15} />}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[13px] font-semibold text-fg">{pack.manifest.displayName}</h3>
            <span className="rounded border border-pr/30 bg-pr/5 px-1.5 py-0.5 text-[10px] text-pr">{t(`capabilityCatalog.kind.${kind}`)}</span>
            <span className="rounded border border-line px-1.5 py-0.5 text-[10px] text-muted">{t(`capabilities.packStatus.${pack.status}`)}</span>
            <span className="rounded border border-line px-1.5 py-0.5 text-[10px] text-muted">Claude · Codex</span>
          </div>
          {pack.manifest.description && <p className="mt-1 text-[11.5px] text-fg-dim">{pack.manifest.description}</p>}
          {missingSecrets > 0 && <p className="mt-1.5 flex items-center gap-1 text-[10.5px] text-run"><ShieldAlert size={11} /> {t("repositorySettings.missingSecrets", { count: missingSecrets })}</p>}
          {hint && <p className="mt-1.5 text-[10.5px] text-muted">{hint}</p>}
        </div>
      </div>

      {state.custom ? (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-md border border-run/30 bg-run/5 px-3 py-2.5">
          <CircleAlert size={14} className="shrink-0 text-run" />
          <p className="min-w-0 flex-1 text-[11px] text-fg-dim">{t("repositorySettings.customAssignment")}</p>
          <Button variant="outline" size="sm" onClick={onOpenAdvancedAssignments}>{t("repositorySettings.openAdvanced")}</Button>
        </div>
      ) : (
        <div className="mt-4 grid items-end gap-3 border-t border-line pt-3 md:grid-cols-[minmax(150px,0.7fr)_minmax(200px,1fr)_auto]">
          <label className="flex flex-col gap-1 text-[10.5px] font-medium text-fg-dim">
            {t("repositorySettings.mode")}
            <Select size="sm" aria-label={t("repositorySettings.modeFor", { name: pack.manifest.displayName })} value={mode} disabled={busy} onChange={(event) => { setMode(event.target.value as CapabilityQuickBindingMode); setError(null); }}>
              <option value="inherit">{scopeKind === "rookery" ? t("settings.capabilitiesNotSet") : t("repositorySettings.mode.inherit")}</option>
              <option value="enabled">{t("repositorySettings.mode.enabled")}</option>
              <option value="disabled">{t("repositorySettings.mode.disabled")}</option>
            </Select>
          </label>
          <fieldset disabled={busy || mode === "inherit"}>
            <legend className="mb-1 text-[10.5px] font-medium text-fg-dim">{t("repositorySettings.agents")}</legend>
            <div className="flex h-8 items-center gap-4">
              {(["master", "worker"] as const).map((agent) => <label key={agent} className="flex items-center gap-2 text-[11.5px] text-fg"><input type="checkbox" aria-label={t(`capabilities.agent.${agent}`)} checked={agents.includes(agent)} onChange={(event) => toggleAgent(agent, event.target.checked)} /> {t(`capabilities.agent.${agent}`)}</label>)}
            </div>
          </fieldset>
          <Button variant="primary" size="sm" loading={busy} onClick={save}>{t("common.save")}</Button>
        </div>
      )}
      {error && <p role="alert" className="mt-3 rounded-md border border-fail/30 bg-fail/5 px-3 py-2 text-[10.5px] text-fail">{error}</p>}
    </article>
  );
}

export function CapabilityScopeBindings({ scopeKind, scopeRef, api, generation, onOpenCatalog, onOpenAdvancedAssignments, onPreviewEffective }: CapabilityScopeBindingsProps): JSX.Element {
  const t = useT();
  const [library, setLibrary] = useState<CapabilityLibrarySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [query, setQuery] = useState("");
  const isRookery = scopeKind === "rookery";

  const load = async (): Promise<void> => {
    const next = await api.loadLibrary();
    setLibrary(next);
    setError(null);
  };
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(null);
    void api.loadLibrary().then(
      (next) => { if (current) { setLibrary(next); setLoading(false); } },
      (cause) => { if (current) { setError(errorMessage(cause)); setLoading(false); } },
    );
    return () => { current = false; };
  }, [api, generation, scopeKind, scopeRef, retry]);

  const visible = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return (library?.packs ?? []).filter((pack) => !normalized || catalogSearchText(pack).includes(normalized));
  }, [library, query]);

  if (loading) return <div className="flex justify-center gap-2 py-20 text-[12px] text-muted"><Loader2 size={14} className="animate-spin" /> {t("common.loading")}</div>;
  if (error) return <div className="flex flex-col items-center gap-3 py-16 text-center"><CircleAlert size={24} className="text-fail" /><p className="text-[12px] text-fail">{t(isRookery ? "settings.capabilitiesLoadFailed" : "repositorySettings.loadFailed")}</p><p className="font-mono text-[10.5px] text-muted">{error}</p><Button variant="outline" size="sm" onClick={() => setRetry((value) => value + 1)}>{t("common.retry")}</Button></div>;

  return (
    <div>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1"><h2 className="text-[16px] font-semibold text-fg">{t(isRookery ? "settings.capabilitiesTitle" : "repositorySettings.capabilities")}</h2><p className="mt-1 text-[11.5px] leading-relaxed text-muted">{t(isRookery ? "settings.capabilitiesDescription" : "repositorySettings.capabilitiesDescription")}</p></div>
        <div className="flex flex-wrap gap-1">
          <Button variant="ghost" size="sm" onClick={onPreviewEffective}>{t("repositorySettings.previewEffective")}</Button>
          <Button variant="ghost" size="sm" onClick={onOpenAdvancedAssignments}>{t("repositorySettings.openAdvanced")}</Button>
        </div>
      </div>
      {(library?.packs.length ?? 0) > 0 && <div className="relative mt-5"><Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" /><Input size="sm" className="pl-8" aria-label={t(isRookery ? "settings.capabilitiesSearch" : "repositorySettings.search")} placeholder={t(isRookery ? "settings.capabilitiesSearch" : "repositorySettings.search")} value={query} onChange={(event) => setQuery(event.target.value)} /></div>}
      {library?.packs.length ? visible.length ? <div className="mt-4 space-y-3">{visible.map((pack) => <CapabilityRow key={pack.instanceId} pack={pack} library={library} scopeKind={scopeKind} scopeRef={scopeRef} state={capabilityScopeState(library.bindings, scopeKind, scopeRef, pack.instanceId)} api={api} onSaved={load} onOpenAdvancedAssignments={onOpenAdvancedAssignments} />)}</div> : <p className="py-14 text-center text-[12px] text-muted">{t(isRookery ? "settings.capabilitiesNoMatches" : "repositorySettings.noMatches")}</p> : <div className="py-16 text-center"><p className="text-[12px] text-muted">{t(isRookery ? "settings.capabilitiesEmpty" : "repositorySettings.empty")}</p><Button className="mt-3" variant="outline" size="sm" onClick={onOpenCatalog}>{t("repositorySettings.openCatalog")}</Button></div>}
    </div>
  );
}
