import { useEffect, useRef, useState } from "react";
import { Boxes, Cable, CheckCircle2, ChevronDown, ChevronRight, CircleAlert, FolderPlus, Loader2, RefreshCw, Search, ShieldCheck, Sparkles, Trash2, X } from "lucide-react";
import type { CapabilityLibraryEntry, CapabilityLibrarySnapshot, McpServerSpec } from "@daemon/core/capabilities/types.js";
import { useT } from "../../i18n/provider.js";
import { cn } from "../../lib/cn.js";
import { Button } from "../../ui/button.js";
import { ConfirmDialog } from "../../ui/confirm-dialog.js";
import { LoadFailed, EmptyState } from "../../ui/load-state.js";
import { Input, Select } from "../../ui/input.js";
import { catalogKind, catalogSearchText, type CapabilityCatalogKind } from "./catalog.js";
import { McpCapabilityDialog } from "./McpCapabilityDialog.js";
import { McpPackBuilderDialog } from "./McpPackBuilderDialog.js";
import { SkillImportDialog } from "./SkillImportDialog.js";
import type { CapabilityCenterApi } from "./types.js";

export interface CapabilityLibraryTabProps {
  api: CapabilityCenterApi;
  generation: number;
  repos: Array<{ id: string; label: string }>;
  pickDirectory(): Promise<string | null>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shortDigest(digest: string): string {
  return digest.length > 20 ? `${digest.slice(0, 12)}…${digest.slice(-8)}` : digest;
}

function mcpEndpoint(server: McpServerSpec): string {
  return server.transport === "stdio"
    ? [server.command, ...(server.args ?? [])].join(" ")
    : server.url;
}

function publicKeys(server: McpServerSpec): string[] {
  return server.transport === "stdio"
    ? Object.keys(server.env ?? {})
    : Object.keys(server.headers ?? {});
}

function SecretControl({ pack, secretKey, api, onChanged }: {
  pack: CapabilityLibraryEntry;
  secretKey: string;
  api: CapabilityCenterApi;
  onChanged(): Promise<void>;
}): JSX.Element {
  const t = useT();
  const configured = pack.secrets.find((item) => item.key === secretKey)?.configured ?? false;
  const [inputKey, setInputKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false); // a stored secret can't be recovered once deleted (audit #103)

  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const value = new FormData(event.currentTarget).get("secret");
        if (typeof value !== "string" || !value.trim()) { setError(t("capabilities.secretRequired")); return; }
        setBusy(true); setError(null);
        void api.setSecret(pack.instanceId, secretKey, value).then(async () => {
          setInputKey((current) => current + 1);
          await onChanged();
        }).catch((cause) => setError(message(cause))).finally(() => setBusy(false));
      }}
    >
      <span className="min-w-32 font-mono text-meta text-fg-dim">{secretKey}</span>
      <span className="text-meta text-muted">{configured ? t("capabilities.secretConfigured") : t("capabilities.secretMissing")}</span>
      <input
        key={inputKey}
        name="secret"
        type="password"
        aria-label={t("capabilities.secretValue", { key: secretKey })}
        autoComplete="new-password"
        className="min-w-40 flex-1 rounded-md border border-line bg-base px-2.5 py-1.5 text-meta text-fg outline-none focus:border-accent"
      />
      <Button type="submit" variant="outline" size="sm" disabled={busy}>{t("common.save")}</Button>
      {configured && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => setConfirmDelete(true)}
        >{t("common.delete")}</Button>
      )}
      {error && <span className="w-full text-meta text-fail">{error}</span>}
      {confirmDelete && (
        <ConfirmDialog
          title={t("capabilities.deleteSecretTitle", { key: secretKey })}
          body={t("capabilities.deleteSecretBody")}
          confirmLabel={t("capabilities.deleteSecret")}
          variant="danger"
          onConfirm={() => {
            setBusy(true); setError(null);
            void api.deleteSecret(pack.instanceId, secretKey).then(onChanged).catch((cause) => setError(message(cause))).finally(() => setBusy(false));
          }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </form>
  );
}

function PackCard({ pack, api, reload, highlighted = false }: {
  pack: CapabilityLibraryEntry;
  api: CapabilityCenterApi;
  reload(): Promise<void>;
  highlighted?: boolean;
}): JSX.Element {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const statusKey = `capabilities.packStatus.${pack.status}`;
  const kind = catalogKind(pack);
  const sourceLabel = pack.sourceKind === "repo-shared"
    ? t("capabilities.packSource.repoShared", { repo: pack.ownerRepoId ?? "—" })
    : pack.sourceKind === "rookery-generated"
      ? t("capabilities.packSource.generated")
      : t("capabilities.packSource.local");

  const mutate = (action: () => Promise<unknown>): void => {
    setBusy(true); setError(null);
    void action().then(reload).catch((cause) => setError(message(cause))).finally(() => setBusy(false));
  };

  return (
    <div data-testid={`capability-pack-${pack.instanceId}`} className={cn("transition-colors", highlighted && "ring-2 ring-inset ring-pr/15")}>
      <div className="flex flex-wrap items-start gap-3 px-4 py-3">
        <button
          className="mt-0.5 rounded p-1 text-faint hover:bg-raised hover:text-fg"
          aria-label={expanded ? t("capabilities.collapse") : t("capabilities.expand")}
          onClick={() => { setExpanded((value) => !value); setReviewed(true); }}
        >{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-body font-medium text-fg">{pack.manifest.displayName}</h3>
            <span className="font-mono text-meta text-faint">v{pack.manifest.version}</span>
            <span className="text-meta text-muted">{t(`capabilityCatalog.kind.${kind}`)}</span>
            <span className="text-meta text-muted">{t(statusKey)}</span>
            <span className="text-meta text-muted">{sourceLabel}</span>
            <span className="text-meta text-muted">Claude · Codex</span>
          </div>
          <p className="mt-1 text-ui text-fg-dim">{pack.manifest.description}</p>
          <p className="mt-1 truncate font-mono text-meta text-faint" title={pack.sourcePath}>{pack.sourcePath}</p>
          <p className="mt-1 font-mono text-meta text-faint" title={pack.digest}>{shortDigest(pack.digest)}</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => mutate(() => api.refresh(pack.instanceId))}>
            <RefreshCw size={12} /> {t("common.refresh")}
          </Button>
          {pack.status === "trusted" ? (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => mutate(() => api.setTrust(pack.instanceId, pack.digest, false))}>{t("capabilities.untrust")}</Button>
          ) : (
            <Button variant="outline" size="sm" disabled={busy || !reviewed || pack.status === "invalid" || pack.status === "source-missing"} onClick={() => mutate(() => api.setTrust(pack.instanceId, pack.digest, true))}>
              <ShieldCheck size={12} /> {t("capabilities.trustCurrent")}
            </Button>
          )}
          {pack.sourceKind !== "repo-shared" && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmRemove(true)}><Trash2 size={12} /> {t("common.delete")}</Button>
          )}
        </div>
      </div>
      {/* Removing a pack drops its bindings, trust and stored secrets — irreversible, so the shared confirm (audit #103). */}
      {confirmRemove && (
        <ConfirmDialog
          title={t("capabilities.removePackTitle", { name: pack.manifest.displayName })}
          body={t("capabilities.removePackBody")}
          confirmLabel={t("capabilities.confirmRemove")}
          variant="danger"
          onConfirm={() => mutate(() => api.removePack(pack.instanceId))}
          onCancel={() => setConfirmRemove(false)}
        />
      )}

      {!reviewed && pack.status !== "trusted" && (
        <p className="border-t border-line-soft px-4 py-2 text-meta text-warn">{t("capabilities.reviewBeforeTrust")}</p>
      )}
      {error && <p className="border-t border-line-soft px-4 py-2 text-meta text-fail">{error}</p>}
      {expanded && (
        <div className="grid gap-4 border-t border-line-soft px-4 py-4 lg:grid-cols-2">
          <section>
            <h4 className="text-meta font-medium text-fg">{t("capabilities.reviewFiles")}</h4>
            <div className="mt-2 max-h-48 space-y-1 overflow-y-auto rounded-md border border-line-soft bg-ink/20 p-2 font-mono text-meta text-faint">
              {pack.files.map((file) => <div key={file.path} className="flex gap-2"><span className="min-w-0 flex-1 break-all">{file.path}</span>{file.executable && <span className="font-sans text-warn">{t("capabilities.executable")}</span>}<span>{file.size} B</span></div>)}
            </div>
            {pack.changes.length > 0 && (
              <div className="mt-3">
                <h4 className="text-meta font-medium text-fg">{t("capabilities.reviewChanges")}</h4>
                <ul className="mt-1 space-y-1 font-mono text-meta text-warn">{pack.changes.map((change) => <li key={`${change.kind}:${change.path}`}>{change.kind} · {change.path}</li>)}</ul>
              </div>
            )}
            {pack.errors.length > 0 && <ul className="mt-3 space-y-1 text-meta text-fail">{pack.errors.map((item, index) => <li key={index}>{item}</li>)}</ul>}
          </section>
          <section className="space-y-4">
            <div>
              <h4 className="text-meta font-medium text-fg">{t("capabilities.reviewContents")}</h4>
              <p className="mt-1 text-meta text-faint">{t("capabilities.instructionsCount", { count: pack.manifest.instructions?.length ?? 0 })} · {t("capabilities.skillsCount", { count: pack.manifest.skills?.length ?? 0 })}</p>
              <div className="mt-2 space-y-2">
                {(pack.manifest.mcpServers ?? []).map((server) => (
                  <div key={server.id} className="rounded-md border border-line-soft p-2 text-meta">
                    <div className="font-medium text-fg">{server.id} · {server.transport}</div>
                    <div className="mt-1 break-all font-mono text-faint">{mcpEndpoint(server)}</div>
                    {(server.enabledTools?.length || server.disabledTools?.length) && <div className="mt-1 text-faint">+ {server.enabledTools?.join(", ") || "—"} · − {server.disabledTools?.join(", ") || "—"}</div>}
                    {publicKeys(server).length > 0 && <div className="mt-1 text-faint">{t("capabilities.publicKeys")}: {publicKeys(server).join(", ")}</div>}
                  </div>
                ))}
              </div>
            </div>
            {pack.secrets.length > 0 && (
              <div>
                <h4 className="text-meta font-medium text-fg">{t("capabilities.secrets")}</h4>
                <p className="mt-1 text-meta text-faint">{t("capabilities.secretsWriteOnly")}</p>
                <div className="mt-2 space-y-2">{pack.secrets.map((secret) => <SecretControl key={secret.key} pack={pack} secretKey={secret.key} api={api} onChanged={reload} />)}</div>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

export function CapabilityLibraryTab({ api, generation, repos, pickDirectory }: CapabilityLibraryTabProps): JSX.Element {
  const t = useT();
  const [library, setLibrary] = useState<CapabilityLibrarySnapshot | null>(null);
  const [loading, setLoading] = useState(true); // first load: nothing to show yet
  const [refreshing, setRefreshing] = useState(false); // reload with the list kept on screen (audit #90)
  const [error, setError] = useState<string | null>(null); // the library load failed
  const [actionError, setActionError] = useState<string | null>(null); // import/refresh/create failed — inline, not the tab (audit #49)
  const libraryRef = useRef(library);
  libraryRef.current = library;
  const [reloadKey, setReloadKey] = useState(0);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [skillOpen, setSkillOpen] = useState(false);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [created, setCreated] = useState<{ pack: CapabilityLibraryEntry; repoId?: string } | null>(null);
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<"all" | CapabilityCatalogKind>("all");

  const reload = async (): Promise<void> => {
    const next = await api.loadLibrary();
    setLibrary(next);
    setError(null);
  };

  useEffect(() => {
    let current = true;
    if (libraryRef.current) setRefreshing(true); else setLoading(true);
    setError(null);
    void api.loadLibrary().then(
      (next) => { if (current) { setLibrary(next); setLoading(false); setRefreshing(false); } },
      (cause) => { if (current) { setError(message(cause)); setLoading(false); setRefreshing(false); } },
    );
    return () => { current = false; };
  }, [api, generation, reloadKey]);

  if (loading && !library) return <div className="flex justify-center gap-2 py-24 text-ui text-muted"><Loader2 size={14} className="animate-spin" /> {t("common.loading")}</div>;
  if (error && !library) return <LoadFailed layout="stack" message={t("capabilities.libraryLoadFailed")} detail={error} onRetry={() => setReloadKey((value) => value + 1)} />;

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visiblePacks = (library?.packs ?? []).filter((pack) =>
    (kindFilter === "all" || catalogKind(pack) === kindFilter)
    && (!normalizedQuery || catalogSearchText(pack).includes(normalizedQuery)),
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1"><h2 className="text-title font-medium text-fg">{t("capabilities.library")}</h2><p className="mt-1 text-meta text-muted">{t("capabilities.libraryDescription")}</p></div>
        <Button variant="primary" size="sm" onClick={() => setMcpOpen(true)}><Cable size={14} /> {t("capabilityCatalog.addMcp")}</Button>
        <Button variant="outline" size="sm" onClick={() => setSkillOpen(true)}><Sparkles size={14} /> {t("capabilityCatalog.importSkill")}</Button>
        <Button variant="outline" size="sm" disabled={repos.length === 0} onClick={() => setBuilderOpen(true)}><Boxes size={14} /> {t("capabilityCatalog.buildPack")}</Button>
        <Button variant="outline" size="sm" onClick={() => { void pickDirectory().then((selected) => selected ? api.addPack(selected).then(reload).catch((cause) => setActionError(message(cause))) : undefined); }}><FolderPlus size={14} /> {t("capabilityCatalog.importPack")}</Button>
        <Button variant="ghost" size="sm" disabled={refreshing} onClick={() => { setRefreshing(true); setActionError(null); void api.refresh().then((next) => setLibrary(next)).catch((cause) => setActionError(message(cause))).finally(() => setRefreshing(false)); }}><RefreshCw size={14} className={cn(refreshing && "animate-spin motion-reduce:animate-none")} /> {t("common.refresh")}</Button>
      </div>
      {error && <LoadFailed className="rounded-[var(--radius)] border border-line px-3.5" message={t("capabilities.refreshFailed")} detail={error} onRetry={() => setReloadKey((value) => value + 1)} retrying={refreshing} />}
      {actionError && (
        <section role="alert" className="flex items-start gap-2 rounded-[var(--radius)] border border-fail/30 bg-fail/5 px-3.5 py-2.5">
          <CircleAlert size={14} className="mt-0.5 shrink-0 text-fail" />
          <div className="min-w-0 flex-1"><p className="text-ui font-medium text-fail">{t("capabilities.actionFailed")}</p><p className="mt-0.5 break-words text-meta text-fg-dim">{actionError}</p></div>
          <Button variant="ghost" size="iconSm" aria-label={t("common.close")} onClick={() => setActionError(null)}><X size={14} /></Button>
        </section>
      )}
      {repos.length === 0 && <p className="rounded-md border border-warn/25 bg-warn/5 px-3 py-2 text-meta text-warn">{t("capabilities.createMcpPackNeedsRepo")}</p>}
      {created && (
        <section role="status" className="flex items-start gap-2 rounded-[var(--radius)] border border-pr/30 bg-pr/5 px-3.5 py-3">
          <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-pr" />
          <div className="min-w-0 flex-1"><p className="text-ui font-medium text-pr">{t(created.repoId ? "capabilities.createMcpPackSuccess" : "capabilityCatalog.createdTitle")}</p><p className="mt-1 text-meta text-fg-dim">{created.repoId ? t("capabilities.createMcpPackNext", { repo: repos.find((repo) => repo.id === created.repoId)?.label ?? created.repoId }) : t("capabilityCatalog.createdNext")}</p></div>
          <Button variant="ghost" size="iconSm" aria-label={t("common.close")} onClick={() => setCreated(null)}><X size={14} /></Button>
        </section>
      )}
      {(library?.packs.length ?? 0) > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-base/20 p-2.5">
          <div className="relative min-w-52 flex-1"><Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" /><Input size="sm" className="pl-8" aria-label={t("capabilityCatalog.search")} placeholder={t("capabilityCatalog.search")} value={query} onChange={(event) => setQuery(event.target.value)} /></div>
          <Select size="sm" className="w-36" aria-label={t("capabilityCatalog.filterAll")} value={kindFilter} onChange={(event) => setKindFilter(event.target.value as "all" | CapabilityCatalogKind)}><option value="all">{t("capabilityCatalog.filterAll")}</option><option value="mcp">{t("capabilityCatalog.filterMcp")}</option><option value="skill">{t("capabilityCatalog.filterSkill")}</option><option value="bundle">{t("capabilityCatalog.filterBundle")}</option></Select>
        </div>
      )}
      {library && library.diagnostics.length > 0 && (
        <section data-testid="capability-library-diagnostics" className="rounded-[var(--radius)] border border-fail/30 bg-fail/5 px-3.5 py-3">
          <div className="flex items-center gap-2 text-ui font-medium text-fail"><CircleAlert size={14} /> {t("capabilities.libraryDiagnostics")}</div>
          <div className="mt-2 space-y-1.5">
            {library.diagnostics.map((diagnostic) => <p key={diagnostic.id} className="text-meta text-fg-dim"><span className="font-mono text-muted">{diagnostic.source}</span> · {diagnostic.message}</p>)}
          </div>
        </section>
      )}
      {library?.packs.length ? visiblePacks.length ? <div className="divide-y divide-line-soft border-y border-line">{visiblePacks.map((pack) => <PackCard key={pack.instanceId} pack={pack} api={api} reload={reload} highlighted={created?.pack.instanceId === pack.instanceId} />)}</div> : <div className="py-16 text-center text-ui text-muted">{t("capabilityCatalog.noMatches")}</div> : <EmptyState layout="stack">{t("capabilities.libraryEmpty")}</EmptyState>}
      {mcpOpen && <McpCapabilityDialog create={(input) => api.createMcp(input)} onCreated={(result) => { setCreated(result); void reload().catch((cause) => setActionError(message(cause))); }} onClose={() => setMcpOpen(false)} />}
      {skillOpen && <SkillImportDialog pickDirectory={pickDirectory} create={(input) => api.createSkill(input)} onCreated={(result) => { setCreated(result); void reload().catch((cause) => setActionError(message(cause))); }} onClose={() => setSkillOpen(false)} />}
      {builderOpen && <McpPackBuilderDialog repos={repos} create={(input) => api.createMcpPack(input)} onCreated={(result) => { setCreated({ pack: result.pack, repoId: result.binding.scopeRef }); void reload().catch((cause) => setActionError(message(cause))); }} onClose={() => setBuilderOpen(false)} />}
    </div>
  );
}
