import { useEffect, useMemo, useState } from "react";
import {
  Blocks,
  Bot,
  Box,
  Braces,
  Cable,
  CircleAlert,
  Command,
  FileText,
  Loader2,
  Plug,
  RefreshCw,
  ShieldCheck,
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
import { Button } from "../ui/button.js";
import { CapabilityAssignmentsTab } from "./capabilities/CapabilityAssignmentsTab.js";
import { CapabilityLibraryTab } from "./capabilities/CapabilityLibraryTab.js";
import type { CapabilityCenterApi, CapabilityTargetOptions } from "./capabilities/types.js";

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
  const size = 15;
  if (kind === "instruction") return <FileText size={size} />;
  if (kind === "skill") return <Sparkles size={size} />;
  if (kind === "command") return <Command size={size} />;
  if (kind === "tool") return <Wrench size={size} />;
  if (kind === "mcp") return <Cable size={size} />;
  if (kind === "hook") return <Zap size={size} />;
  if (kind === "plugin") return <Plug size={size} />;
  return <Box size={size} />;
}

function stateTone(state: CapabilityState): string {
  if (state === "applied" || state === "desired") return "border-pr/30 bg-pr/10 text-pr";
  if (state === "pending-next-turn" || state === "pending-reload") return "border-run/30 bg-run/10 text-run";
  if (state === "blocked" || state === "error") return "border-fail/30 bg-fail/10 text-fail";
  return "border-line bg-raised text-muted";
}

function EntryRow({ entry }: { entry: CapabilityEntry }): JSX.Element {
  const t = useT();
  return (
    <article data-testid={`capability-${entry.id}`} className="rounded-[var(--radius)] border border-line bg-surface/45 px-3.5 py-3">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 rounded-md border border-line bg-raised p-1.5 text-fg-dim"><KindIcon kind={entry.kind} /></span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="text-[13px] font-medium text-fg">{entry.name}</h3>
            <span className="rounded border border-line px-1.5 py-0.5 text-[10px] text-muted">{t(KIND_KEYS[entry.kind])}</span>
            <span className={cn("rounded border px-1.5 py-0.5 text-[10px]", stateTone(entry.state))}>{t(STATE_KEYS[entry.state])}</span>
          </div>
          {entry.description && <p className="mt-1 text-[12px] leading-relaxed text-fg-dim">{entry.description}</p>}
          {entry.detail && <p className="mt-1 break-words font-mono text-[10.5px] leading-relaxed text-muted">{entry.detail}</p>}
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-muted">
            <span>{entry.source}</span>
            <span>{t(SCOPE_KEYS[entry.scope])}</span>
            <span>{t(EVIDENCE_KEYS[entry.evidence])}</span>
            <span>{entry.provider === "rookery" ? "Rookery" : entry.provider === "claude" ? "Claude" : "Codex"}</span>
            {entry.managed && <span>{entry.managed.packId} · {entry.managed.scopeKind}</span>}
          </div>
        </div>
      </div>
    </article>
  );
}

export function CapabilitiesPage({ target, api, targets, generation, initialTab = "effective", initialKind, pickDirectory, onClose }: CapabilitiesPageProps): JSX.Element {
  const t = useT();
  const [snapshot, setSnapshot] = useState<CapabilitySnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState<Category>("all");
  const [exactKind, setExactKind] = useState<CapabilityKind | undefined>(initialKind);
  const [refresh, setRefresh] = useState(0);
  const [tab, setTab] = useState<CenterTab>(initialTab);
  const [reloadBusy, setReloadBusy] = useState<"now" | "idle" | null>(null);
  const [reloadMessage, setReloadMessage] = useState<string | null>(null);
  const [reloadError, setReloadError] = useState<string | null>(null);
  const targetKey = target ? `${target.kind}:${target.id}` : "none";

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
    if (!target) {
      setSnapshot(null);
      setLoading(false);
      setError(null);
      return;
    }
    let current = true;
    setLoading(true);
    setError(null);
    setSnapshot(null);
    void api.loadSnapshot(target).then(
      (next) => { if (current) { setSnapshot(next); setLoading(false); } },
      (cause) => { if (current) { setError(errorMessage(cause)); setLoading(false); } },
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

  const workerNeedsReload = target?.kind === "worker" && snapshot?.entries.some((entry) =>
    Boolean(entry.managed) && (entry.state === "pending-reload" || entry.state === "error"),
  );

  const reloadWorker = async (whenIdle: boolean): Promise<void> => {
    if (target?.kind !== "worker" || reloadBusy) return;
    setReloadBusy(whenIdle ? "idle" : "now");
    setReloadMessage(null);
    setReloadError(null);
    try {
      const result = await api.reloadWorker(target.id, whenIdle);
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
      <header className="drag flex min-h-11 shrink-0 items-center gap-2 border-b border-line px-5 py-2 text-[13px]">
        <Blocks size={16} className="text-accent" />
        <span className="font-semibold tracking-[-0.01em]">{t("capabilities.title")}</span>
        <nav className="no-drag ml-2 flex items-center gap-1" aria-label={t("capabilities.title")}>
          {(["effective", "library", "assignments"] as CenterTab[]).map((item) => (
            <button key={item} aria-pressed={tab === item} onClick={() => setTab(item)} className={cn("rounded-md px-2.5 py-1 text-[11px] transition-colors", tab === item ? "bg-accent/15 text-accent" : "text-muted hover:bg-raised hover:text-fg-dim")}>{t(`capabilities.${item}`)}</button>
          ))}
        </nav>
        <div className="no-drag ml-auto flex items-center gap-1">
          {tab === "effective" && (
            <Button variant="ghost" size="iconSm" aria-label={t("common.refresh")} title={t("common.refresh")} disabled={!target || loading} onClick={() => setRefresh((value) => value + 1)}>
              <RefreshCw size={14} className={cn(loading && "animate-spin")} />
            </Button>
          )}
          <button onClick={onClose} aria-label={t("common.close")} className="rounded-md p-1.5 text-muted transition-colors hover:bg-raised hover:text-fg-dim"><X size={16} /></button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-5xl flex-col gap-4 px-6 py-6">
          {tab === "library" ? (
            <CapabilityLibraryTab api={api} generation={generation} pickDirectory={pickDirectory} />
          ) : tab === "assignments" ? (
            <CapabilityAssignmentsTab api={api} generation={generation} targets={targets} />
          ) : !target ? (
            <div className="flex flex-col items-center justify-center gap-3 py-24 text-center text-muted">
              <Bot size={32} className="opacity-40" />
              <p className="text-[12.5px]">{t("capabilities.noTarget")}</p>
            </div>
          ) : loading ? (
            <div className="flex items-center justify-center gap-2 py-24 text-[12.5px] text-muted"><Loader2 size={15} className="animate-spin" /> {t("common.loading")}</div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
              <CircleAlert size={28} className="text-fail" />
              <p className="text-[12.5px] text-fail">{t("capabilities.loadFailed")}</p>
              <p className="max-w-xl break-words font-mono text-[11px] text-muted">{error}</p>
              <Button variant="outline" size="sm" onClick={() => setRefresh((value) => value + 1)}>{t("common.retry")}</Button>
            </div>
          ) : snapshot ? (
            <>
              <section className="rounded-[var(--radius)] border border-line bg-surface/35 px-4 py-3">
                <div className="flex flex-wrap items-start gap-x-5 gap-y-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-[15px] font-semibold text-fg">{snapshot.target.label}</h2>
                      <span className="rounded border border-line px-1.5 py-0.5 text-[10px] text-muted">{snapshot.target.kind === "session" ? t("capabilities.targetSession") : t("capabilities.targetWorker")}</span>
                      <span className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-fg-dim">{snapshot.target.provider === "codex" ? "Codex" : "Claude"}</span>
                    </div>
                    <p className="mt-1 truncate font-mono text-[11px] text-muted" title={snapshot.target.cwd}>{snapshot.target.cwd}</p>
                    {snapshot.desiredRevision && (
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[10px] text-muted">
                        <span>{t("capabilities.desiredRevision", { revision: snapshot.desiredRevision.slice(0, 12) })}{snapshot.desiredBlocked ? ` · ${t("capabilities.desiredBlocked")}` : ""}</span>
                        <span>{snapshot.appliedRevision
                          ? t("capabilities.appliedRevision", { revision: snapshot.appliedRevision.slice(0, 12) })
                          : t("capabilities.appliedRevisionNone")}</span>
                      </div>
                    )}
                  </div>
                  <p className="font-mono text-[10px] text-muted">{t("capabilities.generatedAt", { time: new Date(snapshot.generatedAt).toLocaleString() })}</p>
                </div>
              </section>

              <section data-testid="capability-summary" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {(Object.keys(counts) as CapabilityState[]).map((state) => (
                  <div key={state} className="rounded-[var(--radius)] border border-line bg-surface/25 px-3 py-2">
                    <div className="text-[18px] font-semibold tabular-nums text-fg">{counts[state]}</div>
                    <div className="text-[10.5px] text-muted">{t(STATE_KEYS[state])}</div>
                  </div>
                ))}
              </section>

              {workerNeedsReload && (
                <section data-testid="capability-worker-reload" className="rounded-[var(--radius)] border border-run/30 bg-run/5 px-3.5 py-3">
                  <div className="flex flex-wrap items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-[12px] font-medium text-run"><RefreshCw size={14} /> {t("capabilities.reloadTitle")}</div>
                      <p className="mt-1 text-[11px] leading-relaxed text-fg-dim">{t("capabilities.reloadDescription")}</p>
                      {reloadMessage && <p role="status" className="mt-2 text-[11px] text-pr">{reloadMessage}</p>}
                      {reloadError && <p role="alert" className="mt-2 break-words font-mono text-[10.5px] text-fail">{reloadError}</p>}
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-2">
                      <Button variant="outline" size="sm" disabled={reloadBusy !== null} onClick={() => void reloadWorker(true)}>
                        {reloadBusy === "idle" && <Loader2 size={13} className="mr-1.5 animate-spin" />}{t("capabilities.reloadWhenIdle")}
                      </Button>
                      <Button size="sm" disabled={reloadBusy !== null} onClick={() => void reloadWorker(false)}>
                        {reloadBusy === "now" && <Loader2 size={13} className="mr-1.5 animate-spin" />}{t("capabilities.reloadNow")}
                      </Button>
                    </div>
                  </div>
                </section>
              )}

              {snapshot.diagnostics.length > 0 && (
                <section className="rounded-[var(--radius)] border border-run/30 bg-run/5 px-3.5 py-3">
                  <div className="flex items-center gap-2 text-[12px] font-medium text-run"><CircleAlert size={14} /> {t("capabilities.partialTitle")}</div>
                  <div className="mt-2 flex flex-col gap-1.5">
                    {snapshot.diagnostics.map((item) => (
                      <div key={item.id} className="flex flex-wrap gap-x-2 text-[11px] leading-relaxed text-fg-dim">
                        <span className="font-mono text-muted">{item.source}</span>
                        <span>{item.message}</span>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              <nav aria-label={t("capabilities.title")} className="flex flex-wrap gap-1 border-b border-line pb-2">
                {CATEGORIES.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => { setExactKind(undefined); setCategory(item.id); }}
                    aria-pressed={selectedCategory === item.id}
                    className={cn("rounded-md px-2.5 py-1.5 text-[11.5px] transition-colors", selectedCategory === item.id ? "bg-accent/12 text-accent" : "text-muted hover:bg-raised hover:text-fg-dim")}
                  >
                    {t(item.labelKey)}
                  </button>
                ))}
              </nav>

              {visibleEntries.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 py-16 text-center text-muted"><ShieldCheck size={26} className="opacity-40" /><p className="text-[12.5px]">{t("capabilities.empty")}</p></div>
              ) : (
                <section className="grid grid-cols-1 gap-2 xl:grid-cols-2">
                  {visibleEntries.map((entry) => <EntryRow key={entry.id} entry={entry} />)}
                </section>
              )}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
