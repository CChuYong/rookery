import { useRef, useState } from "react";
import { CircleAlert, Plus, Trash2, X } from "lucide-react";
import type { CapabilityCatalogCreateResult, CapabilityMcpCreateInput, CapabilityMcpPackCreateInput, CapabilityMcpPackCreateResult } from "@daemon/core/capabilities/types.js";
import { useT } from "../../i18n/provider.js";
import { cn } from "../../lib/cn.js";
import { useDismissTransition } from "../../lib/useDismissTransition.js";
import { useFocusTrap } from "../../lib/useFocusTrap.js";
import { useModalKeys } from "../../lib/useModalKeys.js";
import {
  compileMcpPackDraft,
  createEmptyMcpKeyValueDraft,
  createEmptyMcpSecretDraft,
  createEmptyMcpServerDraft,
  slugMcpId,
  type McpPackDraft,
  type McpPackDraftIssue,
  type McpServerDraft,
} from "../../lib/mcp-pack-draft.js";
import { Button } from "../../ui/button.js";
import { Input, Select, Textarea } from "../../ui/input.js";

interface McpBuilderBaseProps {
  onClose(): void;
}

export type McpPackBuilderDialogProps = McpBuilderBaseProps & (
  | {
      mode?: "pack";
      repos: Array<{ id: string; label: string }>;
      create(input: CapabilityMcpPackCreateInput): Promise<CapabilityMcpPackCreateResult>;
      onCreated(result: CapabilityMcpPackCreateResult): void;
    }
  | {
      mode: "capability";
      create(input: CapabilityMcpCreateInput): Promise<CapabilityCatalogCreateResult>;
      onCreated(result: CapabilityCatalogCreateResult): void;
    }
);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function initialDraft(catalog: boolean): McpPackDraft {
  return {
    displayName: "",
    id: "",
    version: "1.0.0",
    description: "",
    repoId: catalog ? "catalog" : "",
    agents: ["master", "worker"],
    servers: [createEmptyMcpServerDraft("streamable-http")],
  };
}

function switchTransport(server: McpServerDraft, transport: McpServerDraft["transport"]): McpServerDraft {
  if (server.transport === transport) return server;
  const next = createEmptyMcpServerDraft(transport);
  return {
    ...next,
    draftId: server.draftId,
    id: server.id,
    required: server.required,
    enabledToolsText: server.enabledToolsText,
    disabledToolsText: server.disabledToolsText,
    publicEntries: server.publicEntries,
    secretEntries: server.secretEntries,
  };
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }): JSX.Element {
  return <label className={cn("flex min-w-0 flex-col gap-1 text-[10.5px] font-medium text-fg-dim", className)}><span>{label}</span>{children}</label>;
}

export function McpPackBuilderDialog(props: McpPackBuilderDialogProps): JSX.Element {
  const t = useT();
  const catalog = props.mode === "capability";
  const panelRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState(() => initialDraft(catalog));
  const [idTouched, setIdTouched] = useState(false);
  const [issues, setIssues] = useState<McpPackDraftIssue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { closing, dismiss } = useDismissTransition(props.onClose);

  const updateServer = (index: number, update: (server: McpServerDraft) => McpServerDraft): void => {
    setDraft((current) => ({ ...current, servers: current.servers.map((server, position) => position === index ? update(server) : server) }));
  };
  const submit = (): void => {
    if (busy) return;
    const compiled = compileMcpPackDraft(draft);
    if (!compiled.ok) { setIssues(compiled.issues); setError(null); return; }
    setIssues([]); setError(null); setBusy(true);
    if (props.mode === "capability") {
      const input: CapabilityMcpCreateInput = {
        id: compiled.input.id,
        displayName: compiled.input.displayName,
        description: compiled.input.description,
        mcpServer: compiled.input.mcpServers[0]!,
        ...(compiled.input.secretValues ? { secretValues: compiled.input.secretValues } : {}),
      };
      void props.create(input).then((result) => { props.onCreated(result); dismiss(); })
        .catch((cause) => setError(errorMessage(cause))).finally(() => setBusy(false));
      return;
    }
    void props.create(compiled.input).then((result) => { props.onCreated(result); dismiss(); })
      .catch((cause) => setError(errorMessage(cause))).finally(() => setBusy(false));
  };
  useModalKeys({ escape: "ignore", onSubmit: submit });
  useFocusTrap(panelRef);

  return (
    <div className={cn("fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-5 backdrop-blur-sm", closing ? "motion-safe:animate-[overlay-out_130ms_ease-in]" : "motion-safe:animate-[overlay-in_160ms_ease-out]")}> 
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="mcp-pack-builder-title" className={cn("flex max-h-[92vh] w-[min(960px,96vw)] flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-2xl", closing ? "motion-safe:animate-[dialog-out_140ms_ease-in]" : "motion-safe:animate-[dialog-in_180ms_ease-out]")}> 
        <div className="flex items-start gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0 flex-1"><h2 id="mcp-pack-builder-title" className="text-[15px] font-semibold text-fg">{t(catalog ? "capabilityCatalog.mcpTitle" : "mcpPackBuilder.title")}</h2><p className="mt-1 text-[11px] text-muted">{t(catalog ? "capabilityCatalog.mcpDescription" : "mcpPackBuilder.description")}</p></div>
          <Button variant="ghost" size="iconSm" aria-label={t("common.close")} disabled={busy} onClick={dismiss}><X size={15} /></Button>
        </div>

        <form className="min-h-0 flex-1 overflow-y-auto px-5 py-4" onSubmit={(event) => { event.preventDefault(); submit(); }}>
          <section className="grid gap-3 rounded-lg border border-line bg-base/25 p-3 md:grid-cols-2">
            <Field label={t("mcpPackBuilder.packName")}><Input autoFocus size="sm" aria-label={t("mcpPackBuilder.packName")} value={draft.displayName} onChange={(event) => { const displayName = event.target.value; setDraft((current) => { const nextId = idTouched ? current.id : slugMcpId(displayName); return { ...current, displayName, id: nextId, servers: catalog && !idTouched ? current.servers.map((server, index) => index === 0 ? { ...server, id: nextId } : server) : current.servers }; }); }} /></Field>
            <Field label={t("mcpPackBuilder.packId")}><Input size="sm" aria-label={t("mcpPackBuilder.packId")} value={draft.id} onChange={(event) => { setIdTouched(true); setDraft((current) => ({ ...current, id: event.target.value })); }} /></Field>
            {props.mode !== "capability" && <Field label={t("mcpPackBuilder.repo")}><Select size="sm" aria-label={t("mcpPackBuilder.repo")} value={draft.repoId} onChange={(event) => setDraft((current) => ({ ...current, repoId: event.target.value }))}><option value="">{t("mcpPackBuilder.repoPlaceholder")}</option>{props.repos.map((repo) => <option key={repo.id} value={repo.id}>{repo.label}</option>)}</Select></Field>}
            {props.mode !== "capability" && <Field label={t("mcpPackBuilder.version")}><Input size="sm" aria-label={t("mcpPackBuilder.version")} value={draft.version} onChange={(event) => setDraft((current) => ({ ...current, version: event.target.value }))} /></Field>}
            <Field label={t("mcpPackBuilder.packDescription")} className="md:col-span-2"><Input size="sm" aria-label={t("mcpPackBuilder.packDescription")} value={draft.description} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} /></Field>
            {props.mode !== "capability" && <fieldset className="md:col-span-2"><legend className="mb-1 text-[10.5px] font-medium text-fg-dim">{t("mcpPackBuilder.agents")}</legend><div className="flex gap-4">{(["master", "worker"] as const).map((agent) => <label key={agent} className="flex items-center gap-2 text-[11.5px] text-fg"><input type="checkbox" checked={draft.agents.includes(agent)} onChange={(event) => setDraft((current) => ({ ...current, agents: event.target.checked ? [...current.agents, agent] : current.agents.filter((item) => item !== agent) }))} />{t(`mcpPackBuilder.${agent}`)}</label>)}</div></fieldset>}
          </section>

          <div className="mt-4 space-y-3">
            {draft.servers.map((server, index) => (
              <section key={server.draftId} data-testid={`mcp-server-${index}`} className="rounded-lg border border-line bg-base/20 p-3">
                <div className="mb-3 flex items-center gap-2"><h3 className="min-w-0 flex-1 text-[12px] font-semibold text-fg">{t("mcpPackBuilder.serverTitle", { number: index + 1 })}</h3>{draft.servers.length > 1 && <Button variant="danger" size="sm" aria-label={t("mcpPackBuilder.removeServer")} onClick={() => setDraft((current) => ({ ...current, servers: current.servers.filter((_, position) => position !== index) }))}><Trash2 size={12} /> {t("mcpPackBuilder.removeServer")}</Button>}</div>
                <div className="grid gap-3 md:grid-cols-2">
                  <Field label={t("mcpPackBuilder.serverId")}><Input size="sm" aria-label={t("mcpPackBuilder.serverId")} value={server.id} onChange={(event) => updateServer(index, (current) => ({ ...current, id: event.target.value }))} /></Field>
                  <Field label={t("mcpPackBuilder.transport")}><Select size="sm" aria-label={t("mcpPackBuilder.transport")} value={server.transport} onChange={(event) => updateServer(index, (current) => switchTransport(current, event.target.value as McpServerDraft["transport"]))}><option value="streamable-http">{t("mcpPackBuilder.httpTransport")}</option><option value="stdio">{t("mcpPackBuilder.stdioTransport")}</option></Select></Field>
                  {server.transport === "streamable-http" ? <>
                    <Field label={t("mcpPackBuilder.url")} className="md:col-span-2"><Input size="sm" aria-label={t("mcpPackBuilder.url")} value={server.url} onChange={(event) => updateServer(index, (current) => current.transport === "streamable-http" ? { ...current, url: event.target.value } : current)} /></Field>
                    <Field label={t("mcpPackBuilder.bearerKey")}><Input size="sm" aria-label={t("mcpPackBuilder.bearerKey")} value={server.bearerSecretKey} onChange={(event) => updateServer(index, (current) => current.transport === "streamable-http" ? { ...current, bearerSecretKey: event.target.value } : current)} /></Field>
                    <Field label={t("mcpPackBuilder.bearerValue")}><Input size="sm" type="password" autoComplete="new-password" aria-label={t("mcpPackBuilder.bearerValue")} value={server.bearerSecretValue} onChange={(event) => updateServer(index, (current) => current.transport === "streamable-http" ? { ...current, bearerSecretValue: event.target.value } : current)} /></Field>
                  </> : <>
                    <Field label={t("mcpPackBuilder.command")}><Input size="sm" aria-label={t("mcpPackBuilder.command")} value={server.command} onChange={(event) => updateServer(index, (current) => current.transport === "stdio" ? { ...current, command: event.target.value } : current)} /></Field>
                    <Field label={t("mcpPackBuilder.cwd")}><Input size="sm" aria-label={t("mcpPackBuilder.cwd")} value={server.cwd} onChange={(event) => updateServer(index, (current) => current.transport === "stdio" ? { ...current, cwd: event.target.value } : current)} /></Field>
                    <Field label={t("mcpPackBuilder.args")} className="md:col-span-2"><Textarea rows={3} size="sm" aria-label={t("mcpPackBuilder.args")} value={server.argsText} onChange={(event) => updateServer(index, (current) => current.transport === "stdio" ? { ...current, argsText: event.target.value } : current)} /></Field>
                  </>}
                  <Field label={t("mcpPackBuilder.enabledTools")}><Textarea rows={2} size="sm" aria-label={t("mcpPackBuilder.enabledTools")} value={server.enabledToolsText} onChange={(event) => updateServer(index, (current) => ({ ...current, enabledToolsText: event.target.value }))} /></Field>
                  <Field label={t("mcpPackBuilder.disabledTools")}><Textarea rows={2} size="sm" aria-label={t("mcpPackBuilder.disabledTools")} value={server.disabledToolsText} onChange={(event) => updateServer(index, (current) => ({ ...current, disabledToolsText: event.target.value }))} /></Field>
                </div>
                <label className="mt-3 flex items-center gap-2 text-[11px] text-fg"><input type="checkbox" checked={server.required} onChange={(event) => updateServer(index, (current) => ({ ...current, required: event.target.checked }))} />{t("mcpPackBuilder.required")}</label>

                <div className="mt-3 grid gap-3 lg:grid-cols-2">
                  <div className="rounded-md border border-line/70 p-2.5"><div className="flex items-center gap-2"><h4 className="flex-1 text-[10.5px] font-medium text-fg-dim">{t("mcpPackBuilder.publicConfig")}</h4><Button variant="ghost" size="sm" onClick={() => updateServer(index, (current) => ({ ...current, publicEntries: [...current.publicEntries, createEmptyMcpKeyValueDraft()] }))}><Plus size={11} />{t("mcpPackBuilder.addPublic")}</Button></div>{server.publicEntries.map((row) => <div key={row.rowId} className="mt-2 flex gap-1.5"><Input size="xs" className="min-w-0 flex-1" aria-label={t("mcpPackBuilder.target")} value={row.target} onChange={(event) => updateServer(index, (current) => ({ ...current, publicEntries: current.publicEntries.map((item) => item.rowId === row.rowId ? { ...item, target: event.target.value } : item) }))} /><Input size="xs" className="min-w-0 flex-1" aria-label={t("mcpPackBuilder.publicValue")} value={row.value} onChange={(event) => updateServer(index, (current) => ({ ...current, publicEntries: current.publicEntries.map((item) => item.rowId === row.rowId ? { ...item, value: event.target.value } : item) }))} /><Button variant="ghost" size="iconSm" aria-label={t("mcpPackBuilder.removeRow")} onClick={() => updateServer(index, (current) => ({ ...current, publicEntries: current.publicEntries.filter((item) => item.rowId !== row.rowId) }))}><X size={12} /></Button></div>)}</div>
                  <div className="rounded-md border border-line/70 p-2.5"><div className="flex items-center gap-2"><h4 className="flex-1 text-[10.5px] font-medium text-fg-dim">{t("mcpPackBuilder.secretConfig")}</h4><Button variant="ghost" size="sm" onClick={() => updateServer(index, (current) => ({ ...current, secretEntries: [...current.secretEntries, createEmptyMcpSecretDraft()] }))}><Plus size={11} />{t("mcpPackBuilder.addSecret")}</Button></div>{server.secretEntries.map((row) => <div key={row.rowId} className="mt-2 grid grid-cols-[1fr_1fr_1fr_auto] gap-1.5"><Input size="xs" className="min-w-0" aria-label={t("mcpPackBuilder.target")} value={row.target} onChange={(event) => updateServer(index, (current) => ({ ...current, secretEntries: current.secretEntries.map((item) => item.rowId === row.rowId ? { ...item, target: event.target.value } : item) }))} /><Input size="xs" className="min-w-0" aria-label={t("mcpPackBuilder.secretKey")} value={row.key} onChange={(event) => updateServer(index, (current) => ({ ...current, secretEntries: current.secretEntries.map((item) => item.rowId === row.rowId ? { ...item, key: event.target.value } : item) }))} /><Input size="xs" className="min-w-0" type="password" autoComplete="new-password" aria-label={t("mcpPackBuilder.secretValue")} value={row.value} onChange={(event) => updateServer(index, (current) => ({ ...current, secretEntries: current.secretEntries.map((item) => item.rowId === row.rowId ? { ...item, value: event.target.value } : item) }))} /><Button variant="ghost" size="iconSm" aria-label={t("mcpPackBuilder.removeRow")} onClick={() => updateServer(index, (current) => ({ ...current, secretEntries: current.secretEntries.filter((item) => item.rowId !== row.rowId) }))}><X size={12} /></Button></div>)}</div>
                </div>
              </section>
            ))}
          </div>
          {props.mode !== "capability" && <Button className="mt-3" variant="outline" size="sm" onClick={() => setDraft((current) => ({ ...current, servers: [...current.servers, createEmptyMcpServerDraft("streamable-http")] }))}><Plus size={12} /> {t("mcpPackBuilder.addServer")}</Button>}

          {issues.length > 0 && <div className="mt-4 rounded-md border border-fail/30 bg-fail/5 p-3 text-[11px] text-fail"><div className="flex items-center gap-2 font-medium"><CircleAlert size={13} />{t("mcpPackBuilder.validationTitle")}</div><ul className="mt-1.5 list-disc space-y-1 pl-5">{issues.map((issue, index) => <li key={`${issue.code}:${issue.serverIndex ?? "pack"}:${index}`}>{issue.serverIndex === undefined ? "" : `${t("mcpPackBuilder.serverTitle", { number: issue.serverIndex + 1 })}: `}{t(`mcpPackBuilder.issue.${issue.code}`)}</li>)}</ul></div>}
          {error && <p className="mt-4 rounded-md border border-fail/30 bg-fail/5 p-3 text-[11px] text-fail">{error}</p>}
        </form>

        <div className="flex items-center gap-3 border-t border-line px-5 py-3"><p className="min-w-0 flex-1 text-[10.5px] text-run">{t("mcpPackBuilder.trustNotice")}</p><Button variant="outline" disabled={busy} onClick={dismiss}>{t("common.cancel")}</Button><Button variant="primary" aria-label={t(catalog ? "capabilityCatalog.registerMcp" : "mcpPackBuilder.create")} loading={busy} onClick={submit}>{t(catalog ? "capabilityCatalog.registerMcp" : "mcpPackBuilder.create")}</Button></div>
      </div>
    </div>
  );
}
