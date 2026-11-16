import type { SpeedPreference } from "@daemon/core/speed.js";
import { SpeedControl } from "./SpeedControl.js";
import { ChromeMenu, ComposerFooter, COMPOSER_BOX, MenuField, SendButton } from "./ComposerChrome.js";
import { shortModelLabel, permLabel } from "./Composer.js";
import { defaultSpeed } from "../lib/speed.js";
import { useEffect, useRef, useState } from "react";
import type React from "react";
import { GitBranch, SlidersHorizontal, X } from "lucide-react";
import { Input, Select, Textarea } from "../ui/input.js";
import { cn } from "../lib/cn.js";
import { EFFORTS, codexDefaultEffort, codexEffortsFor, effectiveEffort, effortLabelKey, effortSupported } from "../lib/models.js";
import { useStore } from "../store/store.js";
import { spawnDraftKey, useDraftStore, type SpawnDraftSource } from "../store/drafts.js";
import { Segment, type SegmentItem } from "../ui/segment.js";
import { buildSourceTask } from "../lib/source.js";
import { useT } from "../i18n/provider.js";
import { isImeComposing, useScrollActiveIntoView } from "../lib/focus.js";
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
  branchesState?: "loading" | "ready" | "failed"; // the branch list request: the picker holds its place while loading and says when it failed
  integrations?: IntegrationsStatus; // only connected integrations enable GitHub/Linear modes
  searchSource?: (provider: SourceProviderId, query: string) => Promise<SourceItem[]>; // search issues/tickets
  onSpawn: (task: string, label: string, model?: string, effort?: string, base?: string, ticket?: { key: string; url: string }, permissionMode?: string, provider?: string, costBudgetUsd?: number, speed?: SpeedPreference | null) => void | Promise<void>;
  onClose: () => void;
}): JSX.Element {
  const t = useT();
  const [speed, setSpeed] = useState<SpeedPreference | null>(null);
  const settings = useStore((s) => s.settings);
  // The task, label and picked issue/ticket persist per repo in the drafts store (spawnWorker:<repo>), so closing the
  // page, switching away or reloading never loses a half-written task or the ticket it should be linked to. Read once
  // on mount; every edit writes through.
  const [initialDraft] = useState(() => useDraftStore.getState().byPage[spawnDraftKey(p.repo)]);
  const [mode, setMode] = useState<Mode>(initialDraft?.source?.provider ?? "direct");
  const [task, setTaskState] = useState(initialDraft?.text ?? "");
  const [label, setLabelState] = useState(initialDraft?.label ?? "");
  // A restored pick has no body (it already lives in the task text); only identifier/url/title are used after picking.
  const [selected, setSelected] = useState<SourceItem | null>(initialDraft?.source ? { ...initialDraft.source, body: "" } : null);
  const saveDraft = (nextTask: string, nextLabel: string, nextSource: SpawnDraftSource | null = selected): void =>
    useDraftStore.getState().setSpawnDraft_(p.repo, nextTask, nextLabel, nextSource ?? undefined);
  const setTask = (v: string): void => { setTaskState(v); saveDraft(v, label); };
  const setLabel = (v: string): void => { setLabelState(v); saveDraft(task, v); };
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
  const [searchError, setSearchError] = useState(false); // the last search failed (token, gh, network) — not "no results"
  const [focused, setFocused] = useState(false); // show results dropdown only when the search box is focused
  const [spawning, setSpawning] = useState(false);
  const spawningRef = useRef(false);
  // -1 = nothing highlighted yet, so the first ArrowDown press lands cleanly on index 0.
  const [highlight, setHighlight] = useState(-1);
  const resultsRef = useRef<HTMLDivElement>(null);
  useScrollActiveIntoView(resultsRef, highlight); // the arrow-key highlight stays in view (audit #70)
  const [moreOpen, setMoreOpen] = useState(false);
  const seq = useRef(0);

  const githubOk = !!p.integrations?.github.available;
  const linearOk = !!(p.integrations?.linear.configured && p.integrations.linear.valid !== false);
  const MODES: Array<SegmentItem<Mode>> = [
    { value: "direct", label: t("workerSpawnModal.modeDirect") },
    { value: "github", label: "GitHub", disabled: !githubOk, title: githubOk ? undefined : t("workerSpawnModal.githubHint") },
    { value: "linear", label: "Linear", disabled: !linearOk, title: linearOk ? undefined : t("workerSpawnModal.linearHint") },
  ];
  const sourceMode = mode === "github" || mode === "linear";
  const dropdownOpen = focused && (searching || searchError || results.length > 0 || q.trim().length > 0);

  useEffect(() => {
    if (!sourceMode || !p.searchSource || selected) return;
    const mine = ++seq.current;
    setSearching(true);
    setSearchError(false);
    setHighlight(-1); // a new query is in flight — drop any highlight from the previous result list
    const t = setTimeout(() => {
      p.searchSource!(mode, q)
        .then((items) => { if (seq.current === mine) { setResults(items); setSearching(false); } })
        .catch(() => { if (seq.current === mine) { setResults([]); setSearchError(true); setSearching(false); } });
    }, 250);
    return () => clearTimeout(t);
  }, [q, mode, selected]);

  const switchMode = (m: Mode) => {
    if (selected) saveDraft(task, label, null);
    setMode(m); setSelected(null); setQ(""); setResults([]); setHighlight(-1);
  };
  const pickSource = (item: SourceItem) => {
    const built = buildSourceTask(item);
    setTaskState(built.task);
    setLabelState(built.label);
    saveDraft(built.task, built.label, item);
    setSelected(item);
  };
  const clearSelected = () => { saveDraft(task, label, null); setSelected(null); setQ(""); };

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
  // An entered budget must be a positive amount; anything else is an error, never a silently dropped limit (audit #37).
  const cb = costBudget.trim() ? Number(costBudget) : undefined;
  const budgetInvalid = cb != null && !(Number.isFinite(cb) && cb > 0);
  const budgetRef = useRef<HTMLInputElement>(null);
  const spawn = async (): Promise<void> => {
    if (spawningRef.current) return;
    if (budgetInvalid) {
      setMoreOpen(true);
      requestAnimationFrame(() => budgetRef.current?.focus());
      return;
    }
    // codex: empty free-text field → send undefined so the daemon falls back to its codexWorkerModel default.
    const spawnModel = provider === "codex" ? (codexModel.trim() || undefined) : model;
    const costBudgetUsd = cb;
    const draftRepo = p.repo; // the repo select is disabled while spawning, but pin the key anyway
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
      useDraftStore.getState().setSpawnDraft_(draftRepo, "", ""); // spawned: the draft is spent
      dismiss();
    } catch {
      // App owns the localized error toast. Keep this modal and every local draft field mounted for retry.
      spawningRef.current = false;
      setSpawning(false);
    }
  };
  // The repo row re-targets the form without discarding the typed task: App remounts the page per repo (its page key
  // includes the repo), so only what lives in the drafts store survives the switch — the task and label move to the
  // picked repo unless that repo already holds a draft of its own (never overwrite one; the current draft then stays
  // under this repo). Everything else starts fresh on the new page: provider, model, effort, permission, budget and
  // speed return to their defaults, and the repo-bound picks (base branch, picked issue/ticket) are not carried.
  const changeRepo = (next: string): void => {
    if (next !== p.repo && (task || label)) {
      const drafts = useDraftStore.getState();
      if (!drafts.byPage[spawnDraftKey(next)]) {
        drafts.setSpawnDraft_(next, task, label);
        drafts.setSpawnDraft_(p.repo, "", "");
      }
    }
    p.onRepoChange?.(next);
  };
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
  // Enter in the task box spawns (Shift+Enter is a newline) — the same submit key as the other two composers (audit
  // #86); ⌘/Ctrl+Enter still spawns from anywhere inside the form. This is a page, not a modal: the sidebar and status bar stay
  // live, so no window-level key capture (that would swallow Escape for their menus). Escape is intentionally inert
  // here so a typed task is never lost; the source search's own Escape still closes just its results list.
  const onFormKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !isImeComposing(e)) { e.preventDefault(); void spawn(); }
  };

  // An empty task box (and no picked issue) swallows the Enter instead of spawning an idle worker by accident; a blank
  // spawn stays available, deliberately, from the spawn button.
  const onTaskKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key !== "Enter" || e.shiftKey || e.metaKey || e.ctrlKey || isImeComposing(e)) return;
    e.preventDefault();
    if (task.trim() || selected) void spawn();
  };

  // Quiet text control (the composer's footer style): no border, a lift on hover.
  const ghost = "h-6 min-w-0 border-0 bg-transparent px-1 text-ui text-fg-dim hover:bg-raised hover:text-fg focus:ring-0";
  const workerDefaultSpeed = defaultSpeed(settings, provider, "worker");
  const modelLabel = provider === "codex"
    ? codexModels?.find((m) => m.id === effortModel)?.displayName ?? (effortModel || t("settings.codexModelDefaultOption"))
    : shortModelLabel(models.find((m) => m.id === model)?.label ?? model);
  // Trigger text: model · effort, plus only the choices that differ from the default (Plan, Fast).
  const summary = [modelLabel, effortSupported(effectiveModel) ? t(effortLabelKey(currentEffort)) : null,
    permissionMode !== "bypassPermissions" ? permLabel(permissionMode, t) : null,
    (speed ?? workerDefaultSpeed) === "fast" ? t("speed.fast") : null].filter(Boolean).join(" · ");
  const showBranches = p.branches !== undefined || p.branchesState !== undefined;

  return (
    <>
      <div className="drag flex h-10 shrink-0 items-center gap-2 px-4 text-body">
        <span className="font-medium text-fg">{t("workerSpawnModal.title")}</span>
        <button onClick={dismiss} disabled={spawning} aria-label={t("common.close")} className="no-drag ml-auto flex h-6 w-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-raised hover:text-fg-dim disabled:opacity-40">
          <X size={14} />
        </button>
      </div>

      {/* One question, one box, a third of the way down (same column and offset as New session, audit #87). Everything
          belongs to the box: source and base on the left of its footer, the model menu and spawn on the right, the
          rarely touched options in a "More" section inside it. */}
      <div role="region" aria-label={t("workerSpawnModal.title")} onKeyDown={onFormKeyDown} className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6">
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-3 pb-10 pt-[14vh]">
          {/* Same quiet one-liner as NewSessionPage (no display type). The repo is part of the sentence; with several
              registered repos it is an inline select, so switching repo needs no separate control. */}
          <h1 id="worker-spawn-heading" className="text-title font-medium text-fg-dim">
            <span>{t("workerSpawnModal.headingBefore")}</span>
            {p.repos && p.repos.length > 1 && p.onRepoChange ? (
              <Select
                size="xs"
                className="h-auto min-w-0 border-0 bg-transparent px-0.5 font-mono text-title font-medium text-fg underline decoration-line underline-offset-4 hover:decoration-fg-dim focus:ring-0"
                value={p.repo}
                disabled={spawning}
                onChange={(e) => changeRepo(e.target.value)}
                aria-label={t("workerSpawnModal.repoLabel")}
                title={t("workerSpawnModal.repoLabel")}
              >
                {p.repos.map((r) => <option key={r.name} value={r.name}>{r.name}</option>)}
              </Select>
            ) : (
              <span className="font-mono text-fg">{p.repo}</span>
            )}
            <span>{t("workerSpawnModal.headingAfter")}</span>
          </h1>

          <div className={COMPOSER_BOX}>
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
                    if (!dropdownOpen || isImeComposing(e)) return; // the IME's committing Enter must not pick a result (audit #76)
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
              <div ref={resultsRef} id="worker-spawn-source-results" role="listbox" className="mx-3 mt-1 max-h-72 overflow-y-auto rounded-md border border-line bg-ink" onMouseDown={(e) => e.preventDefault()}>
                {searching && results.length === 0 && <div className="px-3 py-2 text-meta text-muted">{t("workerSpawnModal.searching")}</div>}
                {/* A failed search (expired token, gh error) is not "no results" (audit #36). */}
                {!searching && searchError && <div role="alert" className="px-3 py-2 text-meta text-fail">{t("workerSpawnModal.searchFailed")}</div>}
                {!searching && !searchError && results.length === 0 && q.trim().length > 0 && <div className="px-3 py-2 text-meta text-muted">{t("workerSpawnModal.noResults")}</div>}
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
              // The whole box shows focus (focus-within border); text fields are outside the global focus-visible outline.
              className="min-h-[84px] resize-none border-0 bg-transparent px-3 pt-2.5 text-prose focus:ring-0"
              placeholder={sourceMode ? t("workerSpawnModal.taskPlaceholderSource") : t("workerSpawnModal.taskPlaceholderDirect")}
              value={task}
              onChange={(e) => setTask(e.target.value)}
              onKeyDown={onTaskKeyDown}
            />

            {/* Box footer — the composer layout: source and base branch on the left, the model menu and spawn pinned right. */}
            <ComposerFooter
              className="px-3 pb-2"
              left={
                <>
                  <Segment
                    items={MODES}
                    value={mode}
                    onChange={switchMode}
                    variant="pill"
                    aria-label={t("workerSpawnModal.sourceLabel")}
                    className="gap-0.5"
                    itemClassName="px-1.5 py-0.5 text-meta"
                  />
                  {showBranches && (
                    // Holds its place while the list loads and says when it failed (audit #36) — the spawn then uses the repo default.
                    <span className="flex min-w-0 items-center gap-0.5 text-muted">
                      <GitBranch size={12} className="shrink-0" aria-hidden />
                      <Select
                        size="xs"
                        className={ghost}
                        value={p.branchesState === "loading" || p.branchesState === "failed" ? "" : base}
                        disabled={p.branchesState === "loading" || p.branchesState === "failed"}
                        onChange={(e) => setBase(e.target.value)}
                        title={p.branchesState === "failed" ? t("workerSpawnModal.branchesFailed") : t("workerSpawnModal.baseTitle")}
                        aria-label={t("workerSpawnModal.baseLabel")}
                      >
                        {p.branchesState === "loading" ? <option value="">{t("workerSpawnModal.branchesLoading")}</option>
                          : p.branchesState === "failed" ? <option value="">{t("workerSpawnModal.branchesFailed")}</option>
                          : (
                            <>
                              <option value="">{t("workerSpawnModal.baseDefault")}</option>
                              {(p.branches ?? []).map((b) => (
                                <option key={b} value={b}>{t("workerSpawnModal.baseOption", { branch: b })}</option>
                              ))}
                            </>
                          )}
                      </Select>
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => setMoreOpen((v) => !v)}
                    aria-expanded={moreOpen}
                    aria-controls="worker-spawn-more"
                    aria-describedby={budgetInvalid ? "worker-spawn-budget-error" : undefined}
                    className="flex h-6 items-center gap-1 rounded px-1.5 text-meta text-muted transition-colors hover:bg-raised hover:text-fg-dim"
                  >
                    <SlidersHorizontal size={12} aria-hidden /> {t("workerSpawnModal.more")}
                    {budgetInvalid && !moreOpen && <span className="h-1.5 w-1.5 rounded-full bg-fail" aria-hidden />}
                  </button>
                </>
              }
              right={
                <>
                  {/* Backend, model, effort, permission mode and speed — the same model menu as the other composers. */}
                  <ChromeMenu summary={summary} ariaLabel={`${t("composer.modelMenu")}: ${summary}`} side="bottom" disabled={spawning}>
                    <MenuField label={t("workerSpawnModal.provider")}>
                      <Select size="sm" className="w-full" value={provider} onChange={(e) => setProvider(e.target.value as "claude" | "codex")} title={t("workerSpawnModal.provider")} aria-label={t("workerSpawnModal.provider")}>
                        <option value="claude">{t("workerSpawnModal.providerClaude")}</option>
                        <option value="codex">{t("workerSpawnModal.providerCodex")}</option>
                      </Select>
                    </MenuField>
                    <MenuField label={t("composer.fieldModel")}>
                      {provider === "codex" ? (
                        codexModels != null ? (
                          <Select
                            size="sm"
                            className="w-full"
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
                          <Input size="sm" className="w-full" value={codexModel} onChange={(e) => setCodexModel(e.target.value)} placeholder={p.codexDefaultModel} title={t("workerSpawnModal.modelTitle")} aria-label={t("workerSpawnModal.modelTitle")} />
                        )
                      ) : (
                        <Select size="sm" className="w-full" value={model} onChange={(e) => setModel(e.target.value)} title={t("workerSpawnModal.modelTitle")} aria-label={t("workerSpawnModal.modelTitle")}>
                          {models.map((m) => (
                            <option key={m.id} value={m.id}>{m.label}</option>
                          ))}
                          {!models.some((m) => m.id === model) && <option value={model}>{model}</option>}
                        </Select>
                      )}
                    </MenuField>
                    {effortSupported(effectiveModel) && (
                      <MenuField label={t("composer.fieldEffort")}>
                        <Select size="sm" className="w-full" value={currentEffort} onChange={(e) => setEffort(e.target.value)} title={t("workerSpawnModal.effortTitle")} aria-label={t("workerSpawnModal.effortTitle")}>
                          {effortOptions.map((ef) => (
                            <option key={ef} value={ef}>{t(effortLabelKey(ef))}</option>
                          ))}
                        </Select>
                      </MenuField>
                    )}
                    <MenuField label={t("composer.fieldPermission")}>
                      {/* Only bypassPermissions / plan for workers; changeable later in the composer. */}
                      <Select size="sm" className="w-full" value={permissionMode} onChange={(e) => setPermissionMode(e.target.value)} title={t("workerSpawnModal.permTitle")} aria-label={t("workerSpawnModal.permLabel")}>
                        <option value="bypassPermissions">{t("workerSpawnModal.permBypass")}</option>
                        <option value="plan">{t("workerSpawnModal.permPlan")}</option>
                      </Select>
                    </MenuField>
                    <MenuField label={t("speed.label")} hint={t("speed.hint")}>
                      <SpeedControl variant="field" hideLabel speed={speed} defaultSpeed={workerDefaultSpeed} provider={provider} model={provider === "codex" ? effortModel : model} onChange={setSpeed} />
                    </MenuField>
                  </ChromeMenu>
                  <SendButton label={t("workerSpawnModal.spawn")} hint={t("workerSpawnModal.spawnHint")} loading={spawning} onClick={() => void spawn()} />
                </>
              }
            />

            {/* Rarely-touched options inside the box: label and a per-worker cost budget. */}
            {/* Kept mounted (hidden) so typed values survive collapsing the section. */}
            <div id="worker-spawn-more" hidden={!moreOpen} className="grid grid-cols-1 gap-x-4 gap-y-2 border-t border-line-soft px-3 py-2.5 sm:grid-cols-2">
              <label className="flex min-w-0 flex-col gap-1">
                <span className="text-meta text-muted">{t("workerSpawnModal.labelLabel")}</span>
                <Input size="sm" placeholder={t("workerSpawnModal.labelPlaceholder")} value={label} onChange={(e) => setLabel(e.target.value)} />
              </label>
              <label className="flex min-w-0 flex-col gap-1">
                <span className="text-meta text-muted">{t("workerSpawnModal.costBudget")}</span>
                {/* Empty = the workerCostBudgetUsd settings default applies (not unconditionally "no limit"). */}
                <Input
                  ref={budgetRef}
                  size="sm"
                  inputMode="decimal"
                  value={costBudget}
                  onChange={(e) => setCostBudget(e.target.value)}
                  placeholder={t("workerSpawnModal.costBudgetPlaceholder")}
                  title={t("workerSpawnModal.costBudget")}
                  aria-invalid={budgetInvalid || undefined}
                  aria-describedby={budgetInvalid ? "worker-spawn-budget-error" : undefined}
                  className={cn(budgetInvalid && "border-fail")}
                />
                {budgetInvalid && <p id="worker-spawn-budget-error" className="text-meta text-fail">{t("workerSpawnModal.budgetInvalid")}</p>}
              </label>
              <p className="text-meta text-faint sm:col-span-2">{t("workerSpawnModal.footerNote")}</p>
              {provider === "codex" && <p className="text-meta text-faint sm:col-span-2">{t("speed.budgetEstimated")}</p>}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
