import { useEffect, useMemo, useRef, useState } from "react";
import {
  Blocks,
  Box,
  Braces,
  Cable,
  CircleAlert,
  Command,
  FileText,
  Loader2,
  Plug,
  RefreshCw,
  Sparkles,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import type {
  CapabilityEntry,
  CapabilityEvidence,
  CapabilityKind,
  CapabilityScope,
  CapabilitySnapshot,
  CapabilityState,
  CapabilityTarget,
} from "@daemon/core/capabilities/types.js";
import { useT } from "../i18n/provider.js";
import { cn } from "../lib/cn.js";
import { TAB_ACTIVE, TAB_IDLE } from "../lib/ui-tokens.js";
import { Button } from "../ui/button.js";
import { Select } from "../ui/input.js";
import { LoadFailed, EmptyState } from "../ui/load-state.js";
import { CapabilityAssignmentsTab } from "./capabilities/CapabilityAssignmentsTab.js";
import { CapabilityLibraryTab } from "./capabilities/CapabilityLibraryTab.js";
import type { CapabilityCenterApi, CapabilityTargetOptions } from "./capabilities/types.js";
import { capabilityTargetChoice, capabilityTargetKey, defaultCapabilityPreview } from "./capabilities/capability-target.js";

type Category = "all" | "instructions" | "skills" | "tools" | "hooks" | "plugins";
export type CenterTab = "effective" | "library" | "assignments";

export interface CapabilitiesPageProps {
  target: CapabilityTarget | null;
  api: CapabilityCenterApi;
  targets: CapabilityTargetOptions;
  generation: number;
  initialTab?: CenterTab;
  initialKind?: CapabilityKind;
  pickDirectory(): Promise<string | null>;
  onClose(): void;
}

const CATEGORIES: Array<{ id: Category; kinds?: CapabilityKind[]; labelKey: string }> = [
  { id: "all", labelKey: "capabilities.categoryAll" },
  { id: "instructions", kinds: ["instruction"], labelKey: "capabilities.categoryInstructions" },
  { id: "skills", kinds: ["skill", "command"], labelKey: "capabilities.categorySkills" },
  { id: "tools", kinds: ["tool", "mcp"], labelKey: "capabilities.categoryTools" },
  { id: "hooks", kinds: ["hook"], labelKey: "capabilities.categoryHooks" },
  { id: "plugins", kinds: ["plugin", "app"], labelKey: "capabilities.categoryPlugins" },
];

const STATE_KEYS: Record<CapabilityState, string> = {
  applied: "capabilities.stateApplied",
  desired: "capabilities.stateDesired",
  "pending-next-turn": "capabilities.statePendingNextTurn",
  "pending-reload": "capabilities.statePendingReload",
  unavailable: "capabilities.stateUnavailable",
  blocked: "capabilities.stateBlocked",
  suppressed: "capabilities.stateSuppressed",
  error: "capabilities.stateError",
};

const EVIDENCE_KEYS: Record<CapabilityEvidence, string> = {
  runtime: "capabilities.evidenceRuntime",
  declared: "capabilities.evidenceDeclared",
  inferred: "capabilities.evidenceInferred",
};

const SCOPE_KEYS: Record<CapabilityScope, string> = {
  builtin: "capabilities.scopeBuiltin",
  session: "capabilities.scopeSession",
  worker: "capabilities.scopeWorker",
  repo: "capabilities.scopeRepo",
  user: "capabilities.scopeUser",
  system: "capabilities.scopeSystem",
  admin: "capabilities.scopeAdmin",
  plugin: "capabilities.scopePlugin",
};

const KIND_KEYS: Record<CapabilityKind, string> = {
  instruction: "capabilities.kindInstruction",
  skill: "capabilities.kindSkill",
  command: "capabilities.kindCommand",
  tool: "capabilities.kindTool",
  mcp: "capabilities.kindMcp",
  hook: "capabilities.kindHook",
  plugin: "capabilities.kindPlugin",
  app: "capabilities.kindApp",
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function KindIcon({ kind }: { kind: CapabilityKind }): JSX.Element {
  const size = 14;
  if (kind === "instruction") return <FileText size={size} />;
  if (kind === "skill") return <Sparkles size={size} />;
  if (kind === "command") return <Command size={size} />;
  if (kind === "tool") return <Wrench size={size} />;
  if (kind === "mcp") return <Cable size={size} />;
  if (kind === "hook") return <Zap size={size} />;
  if (kind === "plugin") return <Plug size={size} />;
  return <Box size={size} />;
}

function stateDotTone(state: CapabilityState): string {
  if (state === "applied" || state === "desired") return "bg-pr";
  if (state === "pending-next-turn" || state === "pending-reload") return "bg-run";
  if (state === "blocked" || state === "error") return "bg-fail";
  return "bg-stop";
}

// Effective list (audit #98): entries grouped by kind under one header each, dense rows. Meta every row in a group
// shares (source, scope, evidence) is stated once in the group header; a row lists only what differs. The provider
// is shown only when it differs from the target's (it used to repeat "Claude" on every row). Labels are sans, values
// plain; only paths stay mono (#113).
type MetaKey = "source" | "scope" | "evidence";
const META_KEYS: MetaKey[] = ["source", "scope", "evidence"];
const KIND_ORDER: CapabilityKind[] = ["instruction", "skill", "command", "tool", "mcp", "hook", "plugin", "app"];

function metaValue(entry: CapabilityEntry, key: MetaKey, t: (k: string) => string): string {
  if (key === "source") return entry.source;
  if (key === "scope") return t(SCOPE_KEYS[entry.scope]);
  return t(EVIDENCE_KEYS[entry.evidence]);
}

function providerName(provider: CapabilityEntry["provider"]): string {
  return provider === "rookery" ? "Rookery" : provider === "claude" ? "Claude" : "Codex";
}

function MetaItem({ label, value }: { label: string; value: string }): JSX.Element {
  return <span className="inline-flex min-w-0 items-baseline gap-1"><span className="shrink-0 text-faint">{label}</span>{value}</span>;
}

function EntryRow({ entry, shared, targetProvider }: { entry: CapabilityEntry; shared: Partial<Record<MetaKey, string>>; targetProvider: CapabilityEntry["provider"] }): JSX.Element {
  const t = useT();
  const own = META_KEYS.filter((key) => shared[key] === undefined);
  const showProvider = entry.provider !== targetProvider;
  const hasMeta = own.length > 0 || showProvider || !!entry.managed;
  return (
    <div data-testid={`capability-${entry.id}`} className="px-3 py-1.5">
      <div className="flex min-w-0 items-baseline gap-2">
        <span className={cn("shrink-0 text-body font-medium text-fg", entry.kind === "command" && "font-mono")}>{entry.name}</span>
        {entry.description && <span className="min-w-0 flex-1 truncate text-ui text-muted" title={entry.description}>{entry.description}</span>}
        {!entry.description && <span className="flex-1" />}
        <span className="inline-flex shrink-0 items-center gap-1.5 text-meta text-fg-dim" title={t(STATE_KEYS[entry.state])}>
          <span className={cn("h-1.5 w-1.5 rounded-full", stateDotTone(entry.state))} aria-hidden />
          {/* "Applied" is the normal case; only the states that need a look carry a word. */}
          {entry.state === "applied" ? <span className="sr-only">{t(STATE_KEYS[entry.state])}</span> : t(STATE_KEYS[entry.state])}
        </span>
      </div>
      {entry.detail && <p className="mt-0.5 truncate font-mono text-meta text-faint" title={entry.detail}>{entry.detail}</p>}
      {hasMeta && (
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-meta text-muted">
          {own.map((key) => <MetaItem key={key} label={t(`capabilities.meta.${key}`)} value={metaValue(entry, key, t)} />)}
          {showProvider && <MetaItem label={t("capabilities.meta.provider")} value={providerName(entry.provider)} />}
          {entry.managed && <MetaItem label={t("capabilities.meta.pack")} value={`${entry.managed.packId} (${t(`capabilities.bindingScope.${entry.managed.scopeKind}`)})`} />}
        </div>
      )}
    </div>
  );
}

function EntryGroups({ entries, targetProvider }: { entries: CapabilityEntry[]; targetProvider: CapabilityEntry["provider"] }): JSX.Element {
  const t = useT();
  const groups = KIND_ORDER.map((kind) => ({ kind, items: entries.filter((entry) => entry.kind === kind) })).filter((group) => group.items.length > 0);
  return (
    <div className="flex flex-col gap-4">
      {groups.map(({ kind, items }) => {
        const shared: Partial<Record<MetaKey, string>> = {};
        for (const key of META_KEYS) {
          const first = metaValue(items[0]!, key, t);
          if (items.every((entry) => metaValue(entry, key, t) === first)) shared[key] = first;
        }
        return (
          <section key={kind} aria-label={t(KIND_KEYS[kind])}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-b border-line px-3 pb-1.5 text-meta text-muted">
              <span className="inline-flex items-center gap-1.5 text-ui font-medium text-fg-dim"><span className="text-faint"><KindIcon kind={kind} /></span>{t(KIND_KEYS[kind])}</span>
              <span className="tabular-nums">{items.length}</span>
              {META_KEYS.filter((key) => shared[key] !== undefined).map((key) => <MetaItem key={key} label={t(`capabilities.meta.${key}`)} value={shared[key]!} />)}
            </div>
            <div className="divide-y divide-line-soft">
              {items.map((entry) => <EntryRow key={entry.id} entry={entry} shared={shared} targetProvider={targetProvider} />)}
            </div>
          </section>
        );
      })}
    </div>
  );
}

export function CapabilitiesPage({ target, api, targets, generation, initialTab = "effective", initialKind, pickDirectory, onClose }: CapabilitiesPageProps): JSX.Element {
  const t = useT();
  const [snapshot, setSnapshot] = useState<CapabilitySnapshot | null>(null);
  const [loading, setLoading] = useState(false); // first load for this target: nothing to show yet
  const [refreshing, setRefreshing] = useState(false); // reload with the current list kept on screen (audit #90)
  const [error, setError] = useState<string | null>(null);
  // Which target the snapshot on screen belongs to: a reload for the same target keeps it (stale-while-revalidate);
  // a different target starts blank so one target's entries never show under another's header.
  const snapshotKey = useRef<string | null>(null);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const [category, setCategory] = useState<Category>("all");
  const [exactKind, setExactKind] = useState<CapabilityKind | undefined>(initialKind);
  const [refresh, setRefresh] = useState(0);
  const [tab, setTab] = useState<CenterTab>(initialTab);
  const [reloadBusy, setReloadBusy] = useState<"now" | "idle" | null>(null);
  const [reloadMessage, setReloadMessage] = useState<string | null>(null);
  const [reloadError, setReloadError] = useState<string | null>(null);
  const [selectedTarget, setSelectedTarget] = useState<CapabilityTarget>(() => target ?? defaultCapabilityPreview());
  const externalTargetKey = target ? capabilityTargetKey(target) : "none";
  const targetKey = capabilityTargetKey(selectedTarget);
  const preview = selectedTarget.kind === "rookery" || selectedTarget.kind === "repo";

  useEffect(() => {
    setSelectedTarget(target ?? defaultCapabilityPreview());
  }, [externalTargetKey]);

  useEffect(() => {
    setTab(initialTab);
    setCategory("all");
    setExactKind(initialKind);
  }, [initialTab, initialKind]);

  useEffect(() => {
    setCategory("all");
    setReloadBusy(null);
    setReloadMessage(null);
    setReloadError(null);
  }, [targetKey]);

  useEffect(() => {
    if (tab !== "effective") return;
    let current = true;
    const keep = snapshotRef.current !== null && snapshotKey.current === targetKey;
    setError(null);
    if (keep) {
      setRefreshing(true);
    } else {
      setSnapshot(null);
      setLoading(true);
      setRefreshing(false);
    }
    void api.loadSnapshot(selectedTarget).then(
      (next) => { if (current) { snapshotKey.current = targetKey; setSnapshot(next); setLoading(false); setRefreshing(false); } },
      (cause) => { if (current) { setError(errorMessage(cause)); setLoading(false); setRefreshing(false); } },
    );
    return () => { current = false; };
  }, [targetKey, refresh, generation, api, tab]);

  const visibleEntries = useMemo(() => {
    if (exactKind) return snapshot?.entries.filter((entry) => entry.kind === exactKind) ?? [];
    const kinds = CATEGORIES.find((item) => item.id === category)?.kinds;
    return snapshot?.entries.filter((entry) => !kinds || kinds.includes(entry.kind)) ?? [];
  }, [category, exactKind, snapshot]);

  const selectedCategory = exactKind
    ? CATEGORIES.find((item) => item.kinds?.includes(exactKind))?.id ?? "all"
    : category;

  const counts = useMemo(() => {
    const initial: Record<CapabilityState, number> = {
      applied: 0,
      desired: 0,
      "pending-next-turn": 0,
      "pending-reload": 0,
      unavailable: 0,
      blocked: 0,
      suppressed: 0,
      error: 0,
    };
    for (const entry of snapshot?.entries ?? []) initial[entry.state]++;
    return initial;
  }, [snapshot]);

  const workerNeedsReload = selectedTarget.kind === "worker" && snapshot?.entries.some((entry) =>
    Boolean(entry.managed) && (entry.state === "pending-reload" || entry.state === "error"),
  );

  const reloadWorker = async (whenIdle: boolean): Promise<void> => {
    if (selectedTarget.kind !== "worker" || reloadBusy) return;
    setReloadBusy(whenIdle ? "idle" : "now");
    setReloadMessage(null);
    setReloadError(null);
    try {
      const result = await api.reloadWorker(selectedTarget.id, whenIdle);
      setReloadMessage(t(`capabilities.reloadResult.${result.mode}`));
      setRefresh((value) => value + 1);
    } catch (cause) {
      setReloadError(errorMessage(cause));
    } finally {
      setReloadBusy(null);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="drag flex h-10 shrink-0 items-center gap-2 px-4">
        <Blocks size={14} className="text-faint" />
        <span className="text-body font-medium text-fg">{t("capabilities.title")}</span>
        <nav className="no-drag ml-2 flex h-full items-center gap-3" aria-label={t("capabilities.title")}>
          {(["effective", "library", "assignments"] as CenterTab[]).map((item) => (
            <button key={item} aria-pressed={tab === item} onClick={() => setTab(item)} className={cn("relative flex h-full items-center text-ui transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-hi", tab === item ? TAB_ACTIVE : TAB_IDLE)}>{t(`capabilities.${item}`)}</button>
          ))}
        </nav>
        <div className="no-drag ml-auto flex items-center gap-1">
          {tab === "effective" && (
              <Button variant="ghost" size="iconSm" aria-label={t("common.refresh")} title={t("common.refresh")} disabled={loading || refreshing} onClick={() => setRefresh((value) => value + 1)}>
              <RefreshCw size={14} className={cn((loading || refreshing) && "animate-spin motion-reduce:animate-none")} />
            </Button>
          )}
          <Button variant="ghost" size="iconSm" aria-label={t("common.close")} onClick={onClose}><X size={14} /></Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-5xl flex-col gap-4 px-6 py-6">
          {tab === "effective" && (
            <section className="rounded-lg border border-line bg-surface">
              <div className="flex flex-wrap items-center gap-4 px-3.5 py-3">
                <label className="flex items-center gap-2 text-body text-fg-dim">
                  <span className="shrink-0">{t("capabilities.targetLabel")}</span>
                  <Select size="sm" className="w-[min(24rem,60%)]" aria-label={t("capabilities.targetLabel")} value={capabilityTargetChoice(selectedTarget)} onChange={(event) => {
                    const value = event.target.value;
                    const currentPreview = selectedTarget.kind === "rookery" || selectedTarget.kind === "repo"
                      ? selectedTarget
                      : defaultCapabilityPreview();
                    if (value === "rookery") setSelectedTarget({ kind: "rookery", provider: currentPreview.provider, agent: currentPreview.agent });
                    else if (value.startsWith("repo:")) setSelectedTarget({ kind: "repo", id: value.slice(5), provider: currentPreview.provider, agent: currentPreview.agent });
                    else if (value.startsWith("session:")) setSelectedTarget({ kind: "session", id: value.slice(8) });
                    else if (value.startsWith("worker:")) setSelectedTarget({ kind: "worker", id: value.slice(7) });
                  }}>
                    <optgroup label={t("capabilities.targetGroupPreview")}>
                      <option value="rookery">{t("capabilities.targetRookery")}</option>
                      {targets.repos.map((repo) => <option key={repo.id} value={`repo:${repo.id}`}>{repo.label}</option>)}
                    </optgroup>
                    {targets.sessions.length > 0 && <optgroup label={t("capabilities.targetGroupSessions")}>{targets.sessions.map((session) => <option key={session.id} value={`session:${session.id}`}>{session.label}</option>)}</optgroup>}
                    {targets.workers.length > 0 && <optgroup label={t("capabilities.targetGroupWorkers")}>{targets.workers.map((worker) => <option key={worker.id} value={`worker:${worker.id}`}>{worker.label}</option>)}</optgroup>}
                  </Select>
                </label>
                {preview && (
                  <>
                    <label className="flex items-center gap-2 text-body text-fg-dim">
                      <span className="shrink-0">{t("capabilities.providerLabel")}</span>
                      <Select size="sm" className="w-28" aria-label={t("capabilities.providerLabel")} value={selectedTarget.provider} onChange={(event) => setSelectedTarget({ ...selectedTarget, provider: event.target.value as "claude" | "codex" })}>
                        <option value="claude">Claude</option><option value="codex">Codex</option>
                      </Select>
                    </label>
                    <label className="flex items-center gap-2 text-body text-fg-dim">
                      <span className="shrink-0">{t("capabilities.agentLabel")}</span>
                      <Select size="sm" className="w-28" aria-label={t("capabilities.agentLabel")} value={selectedTarget.agent} onChange={(event) => setSelectedTarget({ ...selectedTarget, agent: event.target.value as "master" | "worker" })}>
                        <option value="master">{t("capabilities.agent.master")}</option><option value="worker">{t("capabilities.agent.worker")}</option>
                      </Select>
                    </label>
                  </>
                )}
              </div>
              {snapshot && (
                <div className="border-t border-line-soft px-3.5 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-title font-medium text-fg">
                      {snapshot.target.kind === "rookery" ? t("capabilities.targetRookery") : snapshot.target.label}
                    </h2>
                    <span className="text-meta text-muted">{snapshot.target.kind === "session" ? t("capabilities.targetSession") : snapshot.target.kind === "worker" ? t("capabilities.targetWorker") : snapshot.target.kind === "repo" ? t("capabilities.targetRepo") : t("capabilities.targetRookery")}</span>
                    {(snapshot.target.kind === "repo" || snapshot.target.kind === "rookery") && <span className="text-meta text-muted">{t("capabilities.preview")}</span>}
                    <span className="text-meta text-muted">{snapshot.target.provider === "codex" ? "Codex" : "Claude"}</span>
                    {(snapshot.target.kind === "repo" || snapshot.target.kind === "rookery") && <span className="text-meta text-muted">{t(`capabilities.agent.${snapshot.target.agent}`)}</span>}
                  </div>
                  {snapshot.desiredBlocked && <p className="mt-1 flex items-center gap-1.5 text-ui text-warn"><CircleAlert size={12} aria-hidden /> {t("capabilities.desiredBlocked")}</p>}
                  {/* Revision hashes, the working directory and the inspection time are reference detail, folded away. */}
                  <details className="group mt-1.5">
                    <summary className="w-fit cursor-pointer select-none rounded-sm text-meta text-muted hover:text-fg-dim focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-hi">{t("capabilities.details")}</summary>
                    <dl className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-0.5 text-meta">
                      {snapshot.target.cwd && (<><dt className="text-muted">{t("capabilities.cwd")}</dt><dd className="truncate font-mono text-fg-dim" title={snapshot.target.cwd}>{snapshot.target.cwd}</dd></>)}
                      {snapshot.desiredRevision && (<><dt className="text-muted">{t("capabilities.desiredRevision")}</dt><dd className="font-mono text-fg-dim">{snapshot.desiredRevision.slice(0, 12)}</dd></>)}
                      {snapshot.desiredRevision && (snapshot.target.kind === "session" || snapshot.target.kind === "worker") && (
                        <><dt className="text-muted">{t("capabilities.appliedRevision")}</dt>{snapshot.appliedRevision
                          ? <dd className="font-mono text-fg-dim">{snapshot.appliedRevision.slice(0, 12)}</dd>
                          : <dd className="text-fg-dim">{t("capabilities.appliedRevisionNone")}</dd>}</>
                      )}
                      <dt className="text-muted">{t("capabilities.generatedAt")}</dt><dd className="font-mono text-fg-dim">{new Date(snapshot.generatedAt).toLocaleString()}</dd>
                    </dl>
                  </details>
                </div>
              )}
            </section>
          )}
          {tab === "library" ? (
            <CapabilityLibraryTab api={api} generation={generation} repos={targets.repos} pickDirectory={pickDirectory} />
          ) : tab === "assignments" ? (
            <CapabilityAssignmentsTab api={api} generation={generation} targets={targets} />
          ) : loading ? (
            <div className="flex items-center justify-center gap-2 py-24 text-ui text-muted"><Loader2 size={14} className="animate-spin motion-reduce:animate-none" /> {t("common.loading")}</div>
          ) : error && !snapshot ? (
            <LoadFailed layout="stack" message={t("capabilities.loadFailed")} detail={error} onRetry={() => setRefresh((value) => value + 1)} />
          ) : snapshot ? (
            <>
              {/* A reload failed with the previous list still on screen: keep it, say it may be stale. */}
              {error && <LoadFailed className="rounded-[var(--radius)] border border-line px-3.5" message={t("capabilities.refreshFailed")} detail={error} onRetry={() => setRefresh((value) => value + 1)} retrying={refreshing} />}
              {snapshot.target.kind === "rookery" && (
                <p className="text-meta leading-relaxed text-fg-dim">
                  {t("capabilities.rookeryScopeOnly")}
                </p>
              )}

              {/* Only the states that occur (most of the eight are usually 0), on an even grid that doesn't break into
                  rows of different widths when the window narrows (audit #98). */}
              {(Object.keys(counts) as CapabilityState[]).some((state) => counts[state] > 0) && (
                <section data-testid="capability-summary" className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-px overflow-hidden border-y border-line bg-line-soft">
                  {(Object.keys(counts) as CapabilityState[]).filter((state) => counts[state] > 0).map((state) => {
                    const value = counts[state];
                    const isProblem = state === "blocked" || state === "error" || state === "unavailable";
                    return (
                      <div key={state} className="flex flex-col gap-0.5 bg-ink px-3 py-2">
                        <span className={cn("text-title tabular-nums", isProblem ? "text-fail" : "text-fg")}>{value}</span>
                        <span className="truncate text-meta text-muted" title={t(STATE_KEYS[state])}>{t(STATE_KEYS[state])}</span>
                      </div>
                    );
                  })}
                </section>
              )}

              {workerNeedsReload && (
                <section data-testid="capability-worker-reload" className="rounded-[var(--radius)] border border-warn/30 bg-warn/5 px-3.5 py-3">
                  <div className="flex flex-wrap items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-ui font-medium text-warn"><RefreshCw size={14} /> {t("capabilities.reloadTitle")}</div>
                      <p className="mt-1 text-meta leading-relaxed text-fg-dim">{t("capabilities.reloadDescription")}</p>
                      {reloadMessage && <p role="status" className="mt-2 text-meta text-pr">{reloadMessage}</p>}
                      {reloadError && <p role="alert" className="mt-2 break-words text-meta text-fail">{reloadError}</p>}
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-2">
                      <Button variant="outline" size="sm" disabled={reloadBusy !== null} onClick={() => void reloadWorker(true)}>
                        {reloadBusy === "idle" && <Loader2 size={14} className="mr-1.5 animate-spin motion-reduce:animate-none" />}{t("capabilities.reloadWhenIdle")}
                      </Button>
                      <Button size="sm" disabled={reloadBusy !== null} onClick={() => void reloadWorker(false)}>
                        {reloadBusy === "now" && <Loader2 size={14} className="mr-1.5 animate-spin motion-reduce:animate-none" />}{t("capabilities.reloadNow")}
                      </Button>
                    </div>
                  </div>
                </section>
              )}

              {snapshot.diagnostics.length > 0 && (
                <section className="rounded-[var(--radius)] border border-warn/30 bg-warn/5 px-3.5 py-3">
                  <div className="flex items-center gap-2 text-ui font-medium text-warn"><CircleAlert size={14} /> {t("capabilities.partialTitle")}</div>
                  <div className="mt-2 flex flex-col gap-1.5">
                    {snapshot.diagnostics.map((item) => (
                      <div key={item.id} className="flex flex-wrap gap-x-2 text-meta leading-relaxed text-fg-dim">
                        <span className="font-mono text-muted">{item.source}</span>
                        <span>{item.message}</span>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              <nav aria-label={t("capabilities.title")} className="flex flex-wrap gap-4 border-b border-line">
                {CATEGORIES.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => { setExactKind(undefined); setCategory(item.id); }}
                    aria-pressed={selectedCategory === item.id}
                    className={cn("relative pb-2 text-ui transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-hi", selectedCategory === item.id ? TAB_ACTIVE : TAB_IDLE)}
                  >
                    {t(item.labelKey)}
                  </button>
                ))}
              </nav>

              {visibleEntries.length === 0 ? (
                <EmptyState layout="stack">{t("capabilities.empty")}</EmptyState>
              ) : (
                <EntryGroups entries={visibleEntries} targetProvider={snapshot.target.provider} />
              )}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
