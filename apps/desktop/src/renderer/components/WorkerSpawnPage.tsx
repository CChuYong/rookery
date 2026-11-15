import type { SpeedPreference } from "@daemon/core/speed.js";
import { SpeedControl } from "./SpeedControl.js";
import { defaultSpeed } from "../lib/speed.js";
import { useEffect, useRef, useState } from "react";
import type React from "react";
import { ArrowUp, Folder, GitBranch, Loader2, ShieldOff, SlidersHorizontal, X } from "lucide-react";
import { Input, Select, Textarea } from "../ui/input.js";
import { cn } from "../lib/cn.js";
import { EFFORTS, codexDefaultEffort, codexEffortsFor, effectiveEffort, effortLabelKey, effortSupported } from "../lib/models.js";
import { useStore } from "../store/store.js";
import { Segment, type SegmentItem } from "../ui/segment.js";
import { buildSourceTask } from "../lib/source.js";
import { useT } from "../i18n/provider.js";
import type { SourceItem, SourceProviderId } from "@daemon/core/source-intake.js";
import type { IntegrationsStatus } from "@daemon/protocol/messages.js";

type Mode = "direct" | SourceProviderId; // "direct" | "github" | "linear"

// Full-page worker spawn (replaces the old 520px dialog — docs/superpowers/specs/2026-11-15-worker-spawn-page-design.md).
// Same form logic as before; the layout mirrors NewSessionPage: a title bar, then a centred column with the task box
// (composer surface + model controls) and a labeled options grid instead of placeholder-only fields.
export function WorkerSpawnPage(p: {
  repo: string;
  repos?: Array<{ name: string; path: string }>; // registered repos — the row above the task box re-targets the spawn
  onRepoChange?: (repo: string) => void;
  defaultModel: string;
  defaultEffort: string;
  codexDefaultModel?: string; // placeholder shown in the free-text model field when provider === "codex" (daemon-side default, e.g. settings.codexWorkerModel)
  branches?: string[]; // base branch candidates (picker hidden if absent)
  integrations?: IntegrationsStatus; // only connected integrations enable GitHub/Linear modes
  searchSource?: (provider: SourceProviderId, query: string) => Promise<SourceItem[]>; // search issues/tickets
  onSpawn: (task: string, label: string, model?: string, effort?: string, base?: string, ticket?: { key: string; url: string }, permissionMode?: string, provider?: string, costBudgetUsd?: number, speed?: SpeedPreference | null) => void | Promise<void>;
  onClose: () => void;
}): JSX.Element {
  const t = useT();
  const [speed, setSpeed] = useState<SpeedPreference | null>(null);
  const settings = useStore((s) => s.settings);
  const [mode, setMode] = useState<Mode>("direct");
  const [task, setTask] = useState("");
  const [label, setLabel] = useState("");
  // Agent backend for this worker. Default "claude" (wire-minimal: the spawn() builder below sends `undefined`
  // for claude and only sends an explicit value for "codex", matching the daemon's provider?: "claude"|"codex" contract).
  const [provider, setProvider] = useState<"claude" | "codex">("claude");
  // Starts from the defaults, but this is an override that applies only to this spawn. (The default settings are not touched.)
  const [model, setModel] = useState(p.defaultModel);
  // Free-text codex model (kept in separate state from `model` so switching provider back and forth doesn't
  // clobber either field's value — the Claude <Select> and the codex <Input> remember their own last value).
  const [codexModel, setCodexModel] = useState("");
  const [effort, setEffort] = useState(p.defaultEffort);
  // Cost budget override for this spawn (string; empty = off/unlimited — mirrors the settings-page workerCostBudgetUsd idiom).
  const [costBudget, setCostBudget] = useState("");
  const [permissionMode, setPermissionMode] = useState("bypassPermissions"); // worker SDK permission mode (bypass | plan); changeable later in the composer
  const models = useStore((s) => s.models); // live model list (static fallback if absent)
  const codexModels = useStore((s) => s.codexModels); // codex catalog from codex.models.list; null = couldn't fetch → free-text fallback
  const [base, setBase] = useState(""); // "" = repo default base
  // ── Source search (GitHub issues/PRs · Linear tickets)
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SourceItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<SourceItem | null>(null);
  const [focused, setFocused] = useState(false); // show results dropdown only when the search box is focused
  const [spawning, setSpawning] = useState(false);
  const spawningRef = useRef(false);
  // -1 = nothing highlighted yet, so the first ArrowDown press lands cleanly on index 0.
  const [highlight, setHighlight] = useState(-1);
  const seq = useRef(0);

  const githubOk = !!p.integrations?.github.available;
  const linearOk = !!(p.integrations?.linear.configured && p.integrations.linear.valid !== false);
  const MODES: Array<SegmentItem<Mode>> = [
    { value: "direct", label: t("workerSpawnModal.modeDirect") },
    { value: "github", label: "GitHub", disabled: !githubOk, title: githubOk ? undefined : t("workerSpawnModal.githubHint") },
    { value: "linear", label: "Linear", disabled: !linearOk, title: linearOk ? undefined : t("workerSpawnModal.linearHint") },
  ];
  const sourceMode = mode === "github" || mode === "linear";
  const dropdownOpen = focused && (searching || results.length > 0 || q.trim().length > 0);

  useEffect(() => {
    if (!sourceMode || !p.searchSource || selected) return;
    const mine = ++seq.current;
    setSearching(true);
    setHighlight(-1); // a new query is in flight — drop any highlight from the previous result list
    const t = setTimeout(() => {
      p.searchSource!(mode, q)
        .then((items) => { if (seq.current === mine) { setResults(items); setSearching(false); } })
        .catch(() => { if (seq.current === mine) { setResults([]); setSearching(false); } });
    }, 250);
    return () => clearTimeout(t);
  }, [q, mode, selected]);

  const switchMode = (m: Mode) => { setMode(m); setSelected(null); setQ(""); setResults([]); setHighlight(-1); };
  const pickSource = (item: SourceItem) => {
    const built = buildSourceTask(item);
    setTask(built.task);
    setLabel(built.label);
    setSelected(item);
  };
  const clearSelected = () => { setSelected(null); setQ(""); };

  // The page closes on its own when a successful spawn selects the new worker (navigation leaves the overlay);
  // onClose is still called so callers without that navigation (tests, no result id) return to where they were.
  const dismiss = p.onClose;
  // The model text actually in play for this spawn — the Claude catalog selection, or the codex field (select or free-text).
  const effectiveModel = provider === "codex" ? codexModel : model;
  // Codex effort options come from the selected model's catalog entry when the catalog was fetched; unknown model
  // or no catalog (null) falls back to the generic EFFORTS vocabulary so the selector is never empty.
  // When no model is picked yet (codexModel === ""), resolve efforts off the daemon default model (p.codexDefaultModel)
  // — same idiom as NewSessionPage — so the "" selection offers that model's real efforts, not the generic EFFORTS (which
  // includes `max`, a level codex has no equivalent for).
  // The codex model whose effort vocabulary applies — the picked model, or the daemon default when the
  // field is still "" (same idiom as effortOptions/NewSessionPage).
  const effortModel = effectiveModel || p.codexDefaultModel || "";
  const codexEfforts = provider === "codex" && codexModels != null ? codexEffortsFor(effortModel, codexModels) : null;
  const effortOptions: readonly string[] = codexEfforts && codexEfforts.length > 0 ? codexEfforts : EFFORTS;
  // The effort actually in play, derived at render time (no state-syncing effect): for a codex model a stale
  // Claude-vocab level (e.g. the 'max' default) re-derives to the model's catalog default, so the <select>
  // never renders blank and spawn() never submits a level the model lacks (finding [23]). The raw `effort`
  // state keeps the user's last explicit choice untouched (so switching provider back to claude restores it).
  const currentEffort = effectiveEffort(provider, effortModel, effort, codexModels);
  const spawn = async (): Promise<void> => {
    if (spawningRef.current) return;
    // codex: empty free-text field → send undefined so the daemon falls back to its codexWorkerModel default.
    const spawnModel = provider === "codex" ? (codexModel.trim() || undefined) : model;
    const cb = costBudget.trim() ? Number(costBudget) : undefined;
    const costBudgetUsd = cb != null && Number.isFinite(cb) && cb > 0 ? cb : undefined;
    spawningRef.current = true;
    setSpawning(true);
    try {
      const result = p.onSpawn(
        task.trim(),
        label.trim(),
        spawnModel,
        effortSupported(effectiveModel) ? currentEffort : undefined,
        base || undefined,
        selected ? { key: selected.identifier, url: selected.url } : undefined,
        permissionMode,
        provider === "claude" ? undefined : provider, // wire-minimal: absent means claude
        costBudgetUsd,
        ...(speed === null ? [] as const : [speed] as const),
      );
      // Preserve the synchronous callback behavior used by local/test callers while awaiting the real
      // renderer request contract. Avoiding an unconditional `await undefined` also keeps state updates in
      // the originating click batch for synchronous consumers.
      if (result) await result;
      dismiss();
    } catch {
      // App owns the localized error toast. Keep this modal and every local draft field mounted for retry.
      spawningRef.current = false;
      setSpawning(false);
    }
  };
  // The repo row re-targets the form without discarding the draft: only repo-bound state (base branch, the picked
  // issue/ticket and its search) resets — the task, label and model choices survive the switch.
  const firstRepo = useRef(p.repo);
  useEffect(() => {
    if (firstRepo.current === p.repo) return;
    firstRepo.current = p.repo;
    setBase("");
    setSelected(null);
    setQ("");
    setResults([]);
    setHighlight(-1);
  }, [p.repo]);
  // ⌘/Ctrl+Enter spawns while focus is inside the form. This is a page, not a modal: the sidebar and status bar stay
  // live, so no window-level key capture (that would swallow Escape for their menus). Escape is intentionally inert
  // here so a typed task is never lost; the source search's own Escape still closes just its results list.
  const onFormKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) { e.preventDefault(); void spawn(); }
  };

  // Quiet text controls (NewSessionPage's chip style): no borders, a lift on hover.
  const ghost = "h-6 min-w-0 border-0 bg-transparent px-1.5 text-ui text-fg-dim hover:bg-raised hover:text-fg focus:ring-0";
  const metaGhost = "h-6 min-w-0 border-0 bg-transparent px-1 text-meta text-muted hover:bg-raised hover:text-fg-dim focus:ring-0";
  const [moreOpen, setMoreOpen] = useState(false);

  return (
    <>
      <div className="drag flex h-10 shrink-0 items-center gap-2 px-4 text-body">
        <span className="font-medium text-fg">{t("workerSpawnModal.title")}</span>
        <button onClick={dismiss} disabled={spawning} aria-label={t("common.close")} className="no-drag ml-auto flex h-6 w-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-raised hover:text-fg-dim disabled:opacity-40">
          <X size={14} />
        </button>
      </div>

      {/* One question, one box (the reference: a centred heading, the composer, a quiet meta row). Everything that is
          rarely touched lives behind small controls under the box or the "More" toggle. */}
      <div role="region" aria-label={t("workerSpawnModal.title")} onKeyDown={onFormKeyDown} className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6">
        <div className="mx-auto flex w-full max-w-[720px] flex-1 flex-col justify-center gap-3 pb-[12vh] pt-10">
          <h1 id="worker-spawn-heading" className="mb-2 text-center text-[22px] font-medium tracking-tight text-fg">
            {t("workerSpawnModal.headingIn", { repo: p.repo })}
          </h1>

          <div className="relative">
            <div className="flex flex-col rounded-xl border border-line bg-surface transition-colors focus-within:border-fg-dim/40">
              {/* GitHub/Linear: the picked item, or its search field, sits at the top of the box */}
              {sourceMode && p.searchSource && (
                selected ? (
                  <div className="mx-3 mt-3 flex items-center gap-2 rounded-md bg-raised px-2.5 py-1.5 text-ui">
                    <span className="shrink-0 font-mono text-meta text-accent">{selected.identifier}</span>
                    <span className="truncate text-fg">{selected.title}</span>
                    <button onClick={clearSelected} className="ml-auto shrink-0 rounded p-0.5 text-muted hover:text-fg" title={t("workerSpawnModal.clearSelection")} aria-label={t("workerSpawnModal.clearSelection")}><X size={14} /></button>
                  </div>
                ) : (
                  <Input
                    autoFocus
                    className="mx-3 mt-3 w-auto"
                    size="sm"
                    placeholder={mode === "github" ? t("workerSpawnModal.searchGithub") : t("workerSpawnModal.searchLinear")}
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    onFocus={() => setFocused(true)}
                    onBlur={() => setFocused(false)}
                    onKeyDown={(e) => {
                      if (!dropdownOpen) return;
                      if (e.key === "ArrowDown" && results.length > 0) { e.preventDefault(); setHighlight((h) => Math.min(results.length - 1, h + 1)); }
                      else if (e.key === "ArrowUp" && results.length > 0) { e.preventDefault(); setHighlight((h) => Math.max(0, h - 1)); }
                      else if (e.key === "Enter" && highlight >= 0 && highlight < results.length) { e.preventDefault(); pickSource(results[highlight]!); }
                      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); (e.currentTarget as HTMLInputElement).blur(); } // close only the results list, not the page
                    }}
                    role="combobox"
                    aria-expanded={dropdownOpen}
                    aria-controls="worker-spawn-source-results"
                    aria-activedescendant={highlight >= 0 && highlight < results.length ? `worker-spawn-source-result-${highlight}` : undefined}
                  />
                )
              )}
              {sourceMode && p.searchSource && !selected && dropdownOpen && (
                // onMouseDown preventDefault: keeps the input focused so a click on a result isn't swallowed by blur.
                <div id="worker-spawn-source-results" role="listbox" className="mx-3 mt-1 max-h-72 overflow-y-auto rounded-md border border-line bg-ink" onMouseDown={(e) => e.preventDefault()}>
                  {searching && results.length === 0 && <div className="px-3 py-2 text-meta text-muted">{t("workerSpawnModal.searching")}</div>}
                  {!searching && results.length === 0 && q.trim().length > 0 && <div className="px-3 py-2 text-meta text-muted">{t("workerSpawnModal.noResults")}</div>}
                  {results.map((it, i) => (
                    <button
                      key={`${it.provider}:${it.id}`}
                      id={`worker-spawn-source-result-${i}`}
                      role="option"
                      aria-selected={i === highlight}
                      onClick={() => pickSource(it)}
                      className={cn("flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-ui hover:bg-raised", i === highlight && "bg-raised")}
                    >
                      <span className="shrink-0 font-mono text-meta text-accent">{it.identifier}</span>
                      <span className="truncate text-fg">{it.title}</span>
                      {it.state && <span className="ml-auto shrink-0 text-meta text-muted">{it.state}</span>}
                    </button>
                  ))}
                </div>
              )}

              <Textarea
                autoFocus={mode === "direct"}
                aria-labelledby="worker-spawn-heading"
                className="min-h-[84px] resize-none border-0 bg-transparent px-4 pt-3.5 text-prose focus:ring-0"
                placeholder={sourceMode ? t("workerSpawnModal.taskPlaceholderSource") : t("workerSpawnModal.taskPlaceholderDirect")}
                value={task}
                onChange={(e) => setTask(e.target.value)}
              />

              {/* Box footer: source on the left; agent backend · model · effort and the send button on the right. */}
              <div className="flex flex-wrap items-center gap-1 px-2.5 pb-2.5">
                <Segment
                  items={MODES}
                  value={mode}
                  onChange={switchMode}
                  variant="pill"
                  aria-label={t("workerSpawnModal.sourceLabel")}
                  className="gap-0.5"
                  itemClassName="px-1.5 py-0.5 text-meta"
                />
                <span className="ml-auto" />
                <Select size="xs" className={ghost} value={provider} onChange={(e) => setProvider(e.target.value as "claude" | "codex")} title={t("workerSpawnModal.provider")} aria-label={t("workerSpawnModal.provider")}>
                  <option value="claude">{t("workerSpawnModal.providerClaude")}</option>
                  <option value="codex">{t("workerSpawnModal.providerCodex")}</option>
                </Select>
                {provider === "codex" ? (
                  codexModels != null ? (
                    <Select
                      size="xs"
                      className={ghost}
                      value={codexModel}
                      onChange={(e) => {
                        const nm = e.target.value;
                        setCodexModel(nm);
                        const de = codexDefaultEffort(nm, codexModels);
                        if (de) setEffort(de);
                      }}
                      title={t("workerSpawnModal.modelTitle")}
                      aria-label={t("workerSpawnModal.modelTitle")}
                    >
                      {/* "" = use the codexWorkerModel settings default (never auto-pick a catalog model). */}
                      <option value="">{p.codexDefaultModel ? t("settings.codexModelDefaultOptionWith", { model: p.codexDefaultModel }) : t("settings.codexModelDefaultOption")}</option>
                      {codexModels.map((m) => (
                        <option key={m.id} value={m.id}>{m.displayName}</option>
                      ))}
                      {!codexModels.some((m) => m.id === codexModel) && codexModel && <option value={codexModel}>{codexModel}</option>}
                    </Select>
                  ) : (
                    <Input size="xs" className="h-6 w-36" value={codexModel} onChange={(e) => setCodexModel(e.target.value)} placeholder={p.codexDefaultModel} title={t("workerSpawnModal.modelTitle")} aria-label={t("workerSpawnModal.modelTitle")} />
                  )
                ) : (
                  <Select size="xs" className={ghost} value={model} onChange={(e) => setModel(e.target.value)} title={t("workerSpawnModal.modelTitle")} aria-label={t("workerSpawnModal.modelTitle")}>
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>{m.label}</option>
                    ))}
                    {!models.some((m) => m.id === model) && <option value={model}>{model}</option>}
                  </Select>
                )}
                {effortSupported(effectiveModel) && (
                  <Select size="xs" className={ghost} value={currentEffort} onChange={(e) => setEffort(e.target.value)} title={t("workerSpawnModal.effortTitle")} aria-label={t("workerSpawnModal.effortTitle")}>
                    {effortOptions.map((ef) => (
                      <option key={ef} value={ef}>{t(effortLabelKey(ef))}</option>
                    ))}
                  </Select>
                )}
                <button
                  type="button"
                  onClick={() => void spawn()}
                  disabled={spawning}
                  aria-label={t("workerSpawnModal.spawn")}
                  aria-busy={spawning || undefined}
                  title={t("workerSpawnModal.spawnHint")}
                  className="ml-1 flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-full bg-fg text-ink transition-colors hover:bg-fg/90 disabled:bg-raised disabled:text-faint"
                >
                  {spawning ? <Loader2 size={14} className="animate-spin" /> : <ArrowUp size={15} />}
                </button>
              </div>
            </div>
          </div>

          {/* Meta row under the box: where it runs (repo, base branch) and how (permission), plus "More". */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2">
            {p.repos && p.repos.length > 1 && p.onRepoChange ? (
              <span className="flex items-center gap-0.5 text-muted">
                <Folder size={12} className="shrink-0" aria-hidden />
                <Select size="xs" className={metaGhost} value={p.repo} disabled={spawning} onChange={(e) => p.onRepoChange!(e.target.value)} aria-label={t("workerSpawnModal.repoLabel")} title={t("workerSpawnModal.repoLabel")}>
                  {p.repos.map((r) => <option key={r.name} value={r.name}>{r.name}</option>)}
                </Select>
              </span>
            ) : (
              <span className="flex h-6 items-center gap-1 px-1 text-meta text-muted"><Folder size={12} aria-hidden /> {p.repo}</span>
            )}
            <span className="ml-auto" />
            {p.branches && p.branches.length > 0 && (
              <span className="flex items-center gap-0.5 text-muted">
                <GitBranch size={12} className="shrink-0" aria-hidden />
                <Select size="xs" className={metaGhost} value={base} onChange={(e) => setBase(e.target.value)} title={t("workerSpawnModal.baseTitle")} aria-label={t("workerSpawnModal.baseLabel")}>
                  <option value="">{t("workerSpawnModal.baseDefault")}</option>
                  {p.branches.map((b) => (
                    <option key={b} value={b}>{t("workerSpawnModal.baseOption", { branch: b })}</option>
                  ))}
                </Select>
              </span>
            )}
            <span className="flex items-center gap-0.5 text-muted">
              <ShieldOff size={12} className="shrink-0" aria-hidden />
              {/* Only bypassPermissions / plan for workers; changeable later in the composer. */}
              <Select size="xs" className={metaGhost} value={permissionMode} onChange={(e) => setPermissionMode(e.target.value)} title={t("workerSpawnModal.permTitle")} aria-label={t("workerSpawnModal.permLabel")}>
                <option value="bypassPermissions">{t("workerSpawnModal.permBypass")}</option>
                <option value="plan">{t("workerSpawnModal.permPlan")}</option>
              </Select>
            </span>
            <button
              type="button"
              onClick={() => setMoreOpen((v) => !v)}
              aria-expanded={moreOpen}
              className="flex h-6 items-center gap-1 rounded px-1.5 text-meta text-muted transition-colors hover:bg-raised hover:text-fg-dim"
            >
              <SlidersHorizontal size={12} aria-hidden /> {t("workerSpawnModal.more")}
            </button>
          </div>

          {/* Rarely-touched options: label, a per-worker cost budget, and speed. */}
          {/* Kept mounted (hidden) so typed values survive collapsing the panel. */}
          <div hidden={!moreOpen} className="grid grid-cols-1 gap-x-4 gap-y-2 px-2 sm:grid-cols-2">
              <label className="flex min-w-0 flex-col gap-1">
                <span className="text-meta text-muted">{t("workerSpawnModal.labelLabel")}</span>
                <Input size="sm" placeholder={t("workerSpawnModal.labelPlaceholder")} value={label} onChange={(e) => setLabel(e.target.value)} />
              </label>
              <label className="flex min-w-0 flex-col gap-1">
                <span className="text-meta text-muted">{t("workerSpawnModal.costBudget")}</span>
                {/* Empty = the workerCostBudgetUsd settings default applies (not unconditionally "no limit"). */}
                <Input size="sm" inputMode="decimal" value={costBudget} onChange={(e) => setCostBudget(e.target.value)} placeholder={t("workerSpawnModal.costBudgetPlaceholder")} title={t("workerSpawnModal.costBudget")} />
              </label>
              <label className="flex min-w-0 flex-col gap-1">
                <span className="text-meta text-muted">{t("speed.label")}</span>
                <SpeedControl speed={speed} defaultSpeed={defaultSpeed(settings, provider, "worker")} provider={provider} model={provider === "codex" ? effortModel : model} onChange={setSpeed} />
              </label>
              <p className="text-meta text-faint sm:col-span-2">{t("workerSpawnModal.footerNote")}</p>
          </div>
          {provider === "codex" && <p className="px-2 text-meta text-faint">{t("speed.budgetEstimated")}</p>}
        </div>
      </div>
    </>
  );
}
