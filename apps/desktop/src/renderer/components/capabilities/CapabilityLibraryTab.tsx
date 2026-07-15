import { useEffect, useState } from "react";
import { Cable, CheckCircle2, ChevronDown, ChevronRight, CircleAlert, FolderPlus, Loader2, RefreshCw, ShieldCheck, Trash2, X } from "lucide-react";
import type { CapabilityLibraryEntry, CapabilityLibrarySnapshot, CapabilityMcpPackCreateResult, McpServerSpec } from "@daemon/core/capabilities/types.js";
import { useT } from "../../i18n/provider.js";
import { cn } from "../../lib/cn.js";
import { Button } from "../../ui/button.js";
import { McpPackBuilderDialog } from "./McpPackBuilderDialog.js";
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
      <span className="min-w-32 font-mono text-[11px] text-fg-dim">{secretKey}</span>
      <span className="text-[10.5px] text-muted">{configured ? t("capabilities.secretConfigured") : t("capabilities.secretMissing")}</span>
      <input
        key={inputKey}
        name="secret"
        type="password"
        aria-label={t("capabilities.secretValue", { key: secretKey })}
        autoComplete="new-password"
        className="min-w-40 flex-1 rounded-md border border-line bg-base px-2.5 py-1.5 text-[11px] text-fg outline-none focus:border-accent"
      />
      <Button type="submit" variant="outline" size="sm" disabled={busy}>{t("common.save")}</Button>
      {configured && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => {
            setBusy(true); setError(null);
            void api.deleteSecret(pack.instanceId, secretKey).then(onChanged).catch((cause) => setError(message(cause))).finally(() => setBusy(false));
          }}
        >{t("common.delete")}</Button>
      )}
      {error && <span className="w-full text-[10.5px] text-fail">{error}</span>}
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
    <article data-testid={`capability-pack-${pack.instanceId}`} className={cn("rounded-[var(--radius)] border bg-surface/45 transition-colors", highlighted ? "border-pr/60 ring-2 ring-pr/15" : "border-line")}>
      <div className="flex flex-wrap items-start gap-3 px-4 py-3.5">
        <button
          className="mt-0.5 rounded p-1 text-muted hover:bg-raised hover:text-fg"
          aria-label={expanded ? t("capabilities.collapse") : t("capabilities.expand")}
          onClick={() => { setExpanded((value) => !value); setReviewed(true); }}
        >{expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[13px] font-semibold text-fg">{pack.manifest.displayName}</h3>
            <span className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-muted">v{pack.manifest.version}</span>
            <span className="rounded border border-line px-1.5 py-0.5 text-[10px] text-fg-dim">{t(statusKey)}</span>
            <span className="rounded border border-line px-1.5 py-0.5 text-[10px] text-muted">{sourceLabel}</span>
            <span className="rounded border border-line px-1.5 py-0.5 text-[10px] text-muted">Claude · Codex</span>
          </div>
          <p className="mt-1 text-[11.5px] text-fg-dim">{pack.manifest.description}</p>
          <p className="mt-1 truncate font-mono text-[10px] text-muted" title={pack.sourcePath}>{pack.sourcePath}</p>
          <p className="mt-1 font-mono text-[10px] text-muted" title={pack.digest}>{shortDigest(pack.digest)}</p>
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
          {pack.sourceKind !== "repo-shared" && (!confirmRemove ? (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmRemove(true)}><Trash2 size={12} /> {t("common.delete")}</Button>
          ) : (
            <>
              <Button variant="danger" size="sm" disabled={busy} onClick={() => mutate(() => api.removePack(pack.instanceId))}>{t("capabilities.confirmRemove")}</Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmRemove(false)}>{t("common.cancel")}</Button>
            </>
          ))}
        </div>
      </div>

      {!reviewed && pack.status !== "trusted" && (
        <p className="border-t border-line px-4 py-2 text-[10.5px] text-run">{t("capabilities.reviewBeforeTrust")}</p>
      )}
      {error && <p className="border-t border-fail/20 bg-fail/5 px-4 py-2 text-[11px] text-fail">{error}</p>}
      {expanded && (
        <div className="grid gap-4 border-t border-line px-4 py-4 lg:grid-cols-2">
          <section>
            <h4 className="text-[11px] font-medium text-fg">{t("capabilities.reviewFiles")}</h4>
            <div className="mt-2 max-h-48 space-y-1 overflow-y-auto rounded-md border border-line bg-base/50 p-2 font-mono text-[10px] text-muted">
              {pack.files.map((file) => <div key={file.path} className="flex gap-2"><span className="min-w-0 flex-1 break-all">{file.path}</span>{file.executable && <span className="text-run">{t("capabilities.executable")}</span>}<span>{file.size} B</span></div>)}
            </div>
            {pack.changes.length > 0 && (
              <div className="mt-3">
                <h4 className="text-[11px] font-medium text-fg">{t("capabilities.reviewChanges")}</h4>
                <ul className="mt-1 space-y-1 font-mono text-[10px] text-run">{pack.changes.map((change) => <li key={`${change.kind}:${change.path}`}>{change.kind} · {change.path}</li>)}</ul>
              </div>
            )}
            {pack.errors.length > 0 && <ul className="mt-3 space-y-1 text-[10.5px] text-fail">{pack.errors.map((item, index) => <li key={index}>{item}</li>)}</ul>}
          </section>
          <section className="space-y-4">
            <div>
              <h4 className="text-[11px] font-medium text-fg">{t("capabilities.reviewContents")}</h4>
              <p className="mt-1 text-[10.5px] text-muted">{t("capabilities.instructionsCount", { count: pack.manifest.instructions?.length ?? 0 })} · {t("capabilities.skillsCount", { count: pack.manifest.skills?.length ?? 0 })}</p>
              <div className="mt-2 space-y-2">
                {(pack.manifest.mcpServers ?? []).map((server) => (
                  <div key={server.id} className="rounded-md border border-line bg-base/40 p-2 text-[10.5px]">
                    <div className="font-medium text-fg">{server.id} · {server.transport}</div>
                    <div className="mt-1 break-all font-mono text-muted">{mcpEndpoint(server)}</div>
                    {(server.enabledTools?.length || server.disabledTools?.length) && <div className="mt-1 text-muted">+ {server.enabledTools?.join(", ") || "—"} · − {server.disabledTools?.join(", ") || "—"}</div>}
                    {publicKeys(server).length > 0 && <div className="mt-1 text-muted">{t("capabilities.publicKeys")}: {publicKeys(server).join(", ")}</div>}
                  </div>
                ))}
              </div>
            </div>
            {pack.secrets.length > 0 && (
              <div>
                <h4 className="text-[11px] font-medium text-fg">{t("capabilities.secrets")}</h4>
                <p className="mt-1 text-[10px] text-muted">{t("capabilities.secretsWriteOnly")}</p>
                <div className="mt-2 space-y-2">{pack.secrets.map((secret) => <SecretControl key={secret.key} pack={pack} secretKey={secret.key} api={api} onChanged={reload} />)}</div>
              </div>
            )}
          </section>
        </div>
      )}
    </article>
  );
}

export function CapabilityLibraryTab({ api, generation, repos, pickDirectory }: CapabilityLibraryTabProps): JSX.Element {
  const t = useT();
  const [library, setLibrary] = useState<CapabilityLibrarySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [created, setCreated] = useState<CapabilityMcpPackCreateResult | null>(null);

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

  if (loading) return <div className="flex justify-center gap-2 py-24 text-[12px] text-muted"><Loader2 size={14} className="animate-spin" /> {t("common.loading")}</div>;
  if (error) return <div className="flex flex-col items-center gap-3 py-20 text-center"><CircleAlert size={26} className="text-fail" /><p className="text-[12px] text-fail">{t("capabilities.libraryLoadFailed")}</p><p className="font-mono text-[10.5px] text-muted">{error}</p><Button variant="outline" size="sm" onClick={() => setReloadKey((value) => value + 1)}>{t("common.retry")}</Button></div>;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1"><h2 className="text-[14px] font-semibold text-fg">{t("capabilities.library")}</h2><p className="mt-1 text-[11px] text-muted">{t("capabilities.libraryDescription")}</p></div>
        <Button variant="primary" size="sm" disabled={repos.length === 0} onClick={() => setBuilderOpen(true)}><Cable size={13} /> {t("capabilities.createMcpPack")}</Button>
        <Button variant="outline" size="sm" onClick={() => { void pickDirectory().then((selected) => selected ? api.addPack(selected).then(reload).catch((cause) => setError(message(cause))) : undefined); }}><FolderPlus size={13} /> {t("capabilities.addDirectory")}</Button>
        <Button variant="ghost" size="sm" onClick={() => { setLoading(true); void api.refresh().then((next) => { setLibrary(next); setLoading(false); }).catch((cause) => { setError(message(cause)); setLoading(false); }); }}><RefreshCw size={13} /> {t("common.refresh")}</Button>
      </div>
      {repos.length === 0 && <p className="rounded-md border border-run/25 bg-run/5 px-3 py-2 text-[10.5px] text-run">{t("capabilities.createMcpPackNeedsRepo")}</p>}
      {created && (
        <section role="status" className="flex items-start gap-2 rounded-[var(--radius)] border border-pr/30 bg-pr/5 px-3.5 py-3">
          <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-pr" />
          <div className="min-w-0 flex-1"><p className="text-[12px] font-medium text-pr">{t("capabilities.createMcpPackSuccess")}</p><p className="mt-1 text-[10.5px] text-fg-dim">{t("capabilities.createMcpPackNext", { repo: repos.find((repo) => repo.id === created.binding.scopeRef)?.label ?? created.binding.scopeRef })}</p></div>
          <Button variant="ghost" size="iconSm" aria-label={t("common.close")} onClick={() => setCreated(null)}><X size={13} /></Button>
        </section>
      )}
      {library && library.diagnostics.length > 0 && (
        <section data-testid="capability-library-diagnostics" className="rounded-[var(--radius)] border border-fail/30 bg-fail/5 px-3.5 py-3">
          <div className="flex items-center gap-2 text-[12px] font-medium text-fail"><CircleAlert size={14} /> {t("capabilities.libraryDiagnostics")}</div>
          <div className="mt-2 space-y-1.5">
            {library.diagnostics.map((diagnostic) => <p key={diagnostic.id} className="text-[11px] text-fg-dim"><span className="font-mono text-muted">{diagnostic.source}</span> · {diagnostic.message}</p>)}
          </div>
        </section>
      )}
      {library?.packs.length ? <div className="space-y-3">{library.packs.map((pack) => <PackCard key={pack.instanceId} pack={pack} api={api} reload={reload} highlighted={created?.pack.instanceId === pack.instanceId} />)}</div> : <div className="flex flex-col items-center gap-2 py-20 text-center text-muted"><FolderPlus size={26} className="opacity-40" /><p className="text-[12px]">{t("capabilities.libraryEmpty")}</p></div>}
      {builderOpen && <McpPackBuilderDialog repos={repos} create={(input) => api.createMcpPack(input)} onCreated={(result) => { setCreated(result); void reload().catch((cause) => setError(message(cause))); }} onClose={() => setBuilderOpen(false)} />}
    </div>
  );
}
