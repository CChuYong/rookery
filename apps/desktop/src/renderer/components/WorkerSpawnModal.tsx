import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { Input, Select, Textarea } from "../ui/input.js";
import { Button } from "../ui/button.js";
import { cn } from "../lib/cn.js";
import { EFFORTS, effortLabelKey, effortSupported } from "../lib/models.js";
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
  branches?: string[]; // base branch candidates (picker hidden if absent)
  integrations?: IntegrationsStatus; // only connected integrations enable GitHub/Linear modes
  searchSource?: (provider: SourceProviderId, query: string) => Promise<SourceItem[]>; // search issues/tickets
  onSpawn: (task: string, label: string, model?: string, effort?: string, base?: string, ticket?: { key: string; url: string }, permissionMode?: string) => void;
  onClose: () => void;
}): JSX.Element {
  const t = useT();
  const [mode, setMode] = useState<Mode>("direct");
  const [task, setTask] = useState("");
  const [label, setLabel] = useState("");
  // Starts from the defaults, but this is an override that applies only to this spawn. (The default settings are not touched.)
  const [model, setModel] = useState(p.defaultModel);
  const [effort, setEffort] = useState(p.defaultEffort);
  const [permissionMode, setPermissionMode] = useState("bypassPermissions"); // worker SDK permission mode (bypass | plan); changeable later in the composer
  const models = useStore((s) => s.models); // live model list (static fallback if absent)
  const [base, setBase] = useState(""); // "" = repo default base
  // ── Source search (GitHub issues/PRs · Linear tickets)
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SourceItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<SourceItem | null>(null);
  const [focused, setFocused] = useState(false); // show results dropdown only when the search box is focused
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
  const spawn = () => {
    p.onSpawn(task.trim(), label.trim(), model, effortSupported(model) ? effort : undefined, base || undefined, selected ? { key: selected.identifier, url: selected.url } : undefined, permissionMode);
    dismiss();
  };
  useModalKeys(dismiss, spawn);
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef);

  return (
    <div
      className={cn("fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-sm", closing ? "motion-safe:animate-[overlay-out_130ms_ease-in]" : "motion-safe:animate-[overlay-in_160ms_ease-out]")}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("workerSpawnModal.title")}
        className={cn("w-[520px] rounded-xl border border-line bg-surface p-5", closing ? "motion-safe:animate-[dialog-out_140ms_ease-in]" : "motion-safe:animate-[dialog-in_180ms_ease-out]")}
      >
        <div className="mb-1 text-[14px] font-semibold">{t("workerSpawnModal.title")}</div>
        <div className="mb-3 font-mono text-[11px] text-muted">repo · {p.repo}</div>

        {/* Source mode — write directly / GitHub issues·PRs / Linear tickets */}
        <Segment
          items={MODES}
          value={mode}
          onChange={switchMode}
          variant="pill"
          className="mb-3 gap-1 rounded-[var(--radius)] border border-line bg-ink/40 p-1"
          itemClassName="flex-1 justify-center py-1.5 text-[12px] font-medium"
        />

        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <Select size="sm" className="flex-1" value={model} onChange={(e) => setModel(e.target.value)} title={t("workerSpawnModal.modelTitle")}>
              {models.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
              {!models.some((m) => m.id === model) && <option value={model}>{model}</option>}
            </Select>
            {effortSupported(model) && (
              <Select size="sm" className="w-28" value={effort} onChange={(e) => setEffort(e.target.value)} title={t("workerSpawnModal.effortTitle")}>
                {EFFORTS.map((ef) => (
                  <option key={ef} value={ef}>{t(effortLabelKey(ef))}</option>
                ))}
              </Select>
            )}
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
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={dismiss}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={spawn}>{t("workerSpawnModal.spawn")}</Button>
        </div>
      </div>
    </div>
  );
}
