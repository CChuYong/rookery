import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { Input, Select, Textarea } from "../ui/input.js";
import { Button } from "../ui/button.js";
import { cn } from "../lib/cn.js";
import { EFFORTS, codexDefaultEffort, codexEffortsFor, effectiveEffort, effortLabelKey, effortSupported } from "../lib/models.js";
import { useStore } from "../store/store.js";
import { useModalKeys } from "../lib/useModalKeys.js";
import { useDismissTransition } from "../lib/useDismissTransition.js";
import { useFocusTrap } from "../lib/useFocusTrap.js";
import { Segment, type SegmentItem } from "../ui/segment.js";
import { buildSourceTask } from "../lib/source.js";
import { useT } from "../i18n/provider.js";
import type { SourceItem, SourceProviderId } from "@daemon/core/source-intake.js";
import type { IntegrationsStatus } from "@daemon/protocol/messages.js";

type Mode = "direct" | SourceProviderId; // "direct" | "github" | "linear"

export function WorkerSpawnModal(p: {
  repo: string;
  defaultModel: string;
  defaultEffort: string;
  codexDefaultModel?: string; // placeholder shown in the free-text model field when provider === "codex" (daemon-side default, e.g. settings.codexWorkerModel)
  branches?: string[]; // base branch candidates (picker hidden if absent)
  integrations?: IntegrationsStatus; // only connected integrations enable GitHub/Linear modes
  searchSource?: (provider: SourceProviderId, query: string) => Promise<SourceItem[]>; // search issues/tickets
  onSpawn: (task: string, label: string, model?: string, effort?: string, base?: string, ticket?: { key: string; url: string }, permissionMode?: string, provider?: string, costBudgetUsd?: number) => void | Promise<void>;
  onClose: () => void;
}): JSX.Element {
  const t = useT();
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

  const { closing, dismiss } = useDismissTransition(p.onClose);
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
  useModalKeys({ escape: "ignore", onSubmit: spawn });
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef);

  return (
    <div
      className={cn("fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm", closing ? "motion-safe:animate-[overlay-out_130ms_ease-in]" : "motion-safe:animate-[overlay-in_160ms_ease-out]")}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("workerSpawnModal.title")}
        className={cn("flex max-h-[calc(100vh-2rem)] w-full max-w-[520px] flex-col overflow-hidden rounded-xl border border-line bg-surface", closing ? "motion-safe:animate-[dialog-out_140ms_ease-in]" : "motion-safe:animate-[dialog-in_180ms_ease-out]")}
      >
        <div className="shrink-0 px-5 pb-3 pt-5">
          <div className="mb-1 text-[14px] font-semibold">{t("workerSpawnModal.title")}</div>
          <div className="mb-3 font-mono text-[11px] text-muted">repo · {p.repo}</div>

          {/* Source mode — write directly / GitHub issues·PRs / Linear tickets */}
          <Segment
            items={MODES}
            value={mode}
            onChange={switchMode}
            variant="pill"
            className="gap-1 rounded-[var(--radius)] border border-line bg-ink/40 p-1"
            itemClassName="flex-1 justify-center py-1.5 text-[12px] font-medium"
          />
        </div>

        <div data-dialog-scroll-body className="min-h-0 overflow-y-auto px-5 pb-4">
          <div className="flex flex-col gap-2">
          {/* Agent backend for this worker — copies the permissionMode hardcoded-<option> idiom below. */}
          <Select size="sm" value={provider} onChange={(e) => setProvider(e.target.value as "claude" | "codex")} title={t("workerSpawnModal.provider")}>
            <option value="claude">{t("workerSpawnModal.providerClaude")}</option>
            <option value="codex">{t("workerSpawnModal.providerCodex")}</option>
          </Select>
          <div className="flex gap-2">
            {provider === "codex" ? (
              codexModels != null ? (
                // codex catalog fetched — dropdown, selecting a model also pre-selects its default effort.
                <Select
                  size="sm"
                  className="flex-1"
                  value={codexModel}
                  onChange={(e) => {
                    const nm = e.target.value;
                    setCodexModel(nm);
                    const de = codexDefaultEffort(nm, codexModels);
                    if (de) setEffort(de);
                  }}
                  title={t("workerSpawnModal.modelTitle")}
                >
                  {/* Task 4 fold-in (Task 3 review Minor #1): a fresh open with the catalog present used to render
                      this <Select value=""> blank. This leading "" option shows a "use default" label instead — the
                      daemon applies the codexWorkerModel settings default when the spawn's model is empty, so we
                      deliberately do NOT auto-pick a catalog model here (that would silently override the default). */}
                  <option value="">{p.codexDefaultModel ? t("settings.codexModelDefaultOptionWith", { model: p.codexDefaultModel }) : t("settings.codexModelDefaultOption")}</option>
                  {codexModels.map((m) => (
                    <option key={m.id} value={m.id}>{m.displayName}</option>
                  ))}
                  {!codexModels.some((m) => m.id === codexModel) && codexModel && <option value={codexModel}>{codexModel}</option>}
                </Select>
              ) : (
                // codex catalog unavailable (couldn't fetch) — free text, daemon default when empty.
                <Input
                  size="sm"
                  className="flex-1"
                  value={codexModel}
                  onChange={(e) => setCodexModel(e.target.value)}
                  placeholder={p.codexDefaultModel}
                  title={t("workerSpawnModal.modelTitle")}
                />
              )
            ) : (
              <Select size="sm" className="flex-1" value={model} onChange={(e) => setModel(e.target.value)} title={t("workerSpawnModal.modelTitle")}>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
                {!models.some((m) => m.id === model) && <option value={model}>{model}</option>}
              </Select>
            )}
            {effortSupported(effectiveModel) && (
              <Select size="sm" className="w-28" value={currentEffort} onChange={(e) => setEffort(e.target.value)} title={t("workerSpawnModal.effortTitle")}>
                {effortOptions.map((ef) => (
                  <option key={ef} value={ef}>{t(effortLabelKey(ef))}</option>
                ))}
              </Select>
            )}
            {/* Optional lifetime USD cost ceiling for this worker (cost budget guard) — empty = the workerCostBudgetUsd
                settings default applies (via the server's subFactory override ?? default ?? unlimited chain), not
                unconditionally "no limit". */}
            <Input
              size="sm"
              className="w-28"
              value={costBudget}
              onChange={(e) => setCostBudget(e.target.value)}
              placeholder="default"
              title={t("workerSpawnModal.costBudget")}
            />
          </div>
          {/* SDK permission mode for this worker — only bypassPermissions / plan (no default/acceptEdits). Changeable later in the composer. */}
          <Select size="sm" value={permissionMode} onChange={(e) => setPermissionMode(e.target.value)} title={t("workerSpawnModal.permTitle")}>
            <option value="bypassPermissions">{t("workerSpawnModal.permBypass")}</option>
            <option value="plan">{t("workerSpawnModal.permPlan")}</option>
          </Select>
          {p.branches && p.branches.length > 0 && (
            <Select size="sm" value={base} onChange={(e) => setBase(e.target.value)} title={t("workerSpawnModal.baseTitle")}>
              <option value="">{t("workerSpawnModal.baseDefault")}</option>
              {p.branches.map((b) => (
                <option key={b} value={b}>{t("workerSpawnModal.baseOption", { branch: b })}</option>
              ))}
            </Select>
          )}

          {/* GitHub/Linear mode: search → select → the task below is auto-filled (editable) */}
          {sourceMode && p.searchSource && (
            <div className="flex flex-col gap-1.5">
              {selected ? (
                <div className="flex items-center gap-2 rounded-[var(--radius)] border border-accent/40 bg-accent/10 px-2.5 py-1.5 text-[12px]">
                  <span className="shrink-0 font-mono text-[11px] text-accent">{selected.identifier}</span>
                  <span className="truncate text-fg">{selected.title}</span>
                  <button onClick={clearSelected} className="ml-auto shrink-0 rounded p-0.5 text-muted hover:text-fg" title={t("workerSpawnModal.clearSelection")} aria-label={t("workerSpawnModal.clearSelection")}><X size={13} /></button>
                </div>
              ) : (
                <>
                  <Input
                    autoFocus
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
                      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); (e.currentTarget as HTMLInputElement).blur(); } // close only the results list, not the whole modal
                    }}
                    role="combobox"
                    aria-expanded={dropdownOpen}
                    aria-controls="worker-spawn-source-results"
                    aria-activedescendant={highlight >= 0 && highlight < results.length ? `worker-spawn-source-result-${highlight}` : undefined}
                  />
                  {dropdownOpen && (
                    // onMouseDown preventDefault: prevents the dropdown from closing first on input blur when a result is clicked, which would swallow the click.
                    <div id="worker-spawn-source-results" role="listbox" className="max-h-44 overflow-y-auto rounded-[var(--radius)] border border-line bg-ink/40" onMouseDown={(e) => e.preventDefault()}>
                      {searching && results.length === 0 && <div className="px-2.5 py-1.5 text-[11px] text-muted">{t("workerSpawnModal.searching")}</div>}
                      {!searching && results.length === 0 && q.trim().length > 0 && <div className="px-2.5 py-1.5 text-[11px] text-muted">{t("workerSpawnModal.noResults")}</div>}
                      {results.map((it, i) => (
                        <button
                          key={`${it.provider}:${it.id}`}
                          id={`worker-spawn-source-result-${i}`}
                          role="option"
                          aria-selected={i === highlight}
                          onClick={() => pickSource(it)}
                          className={cn("flex w-full items-baseline gap-2 px-2.5 py-1.5 text-left text-[12px] hover:bg-accent/10", i === highlight && "bg-accent/10")}
                        >
                          <span className="shrink-0 font-mono text-[11px] text-accent">{it.identifier}</span>
                          <span className="truncate text-fg">{it.title}</span>
                          {it.state && <span className="ml-auto shrink-0 text-[10px] text-muted">{it.state}</span>}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          <Input placeholder={t("workerSpawnModal.labelPlaceholder")} value={label} onChange={(e) => setLabel(e.target.value)} />
          <Textarea
            autoFocus={mode === "direct"}
            className="min-h-[120px] resize-y"
            placeholder={sourceMode ? t("workerSpawnModal.taskPlaceholderSource") : t("workerSpawnModal.taskPlaceholderDirect")}
            value={task}
            onChange={(e) => setTask(e.target.value)}
          />
          </div>
          <p className="mt-2 text-[11.5px] text-muted">{t("workerSpawnModal.footerNote")}</p>
        </div>
        <div data-dialog-footer className="flex shrink-0 justify-end gap-2 border-t border-line px-5 py-4">
          <Button variant="outline" disabled={spawning} onClick={dismiss}>{t("common.cancel")}</Button>
          <Button variant="primary" loading={spawning} onClick={() => void spawn()}>{t("workerSpawnModal.spawn")}</Button>
        </div>
      </div>
    </div>
  );
}
