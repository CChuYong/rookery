import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { Input, Select, Textarea } from "../ui/input.js";
import { Button } from "../ui/button.js";
import { cn } from "../lib/cn.js";
import { EFFORTS, effortSupported } from "../lib/models.js";
import { useStore } from "../store/store.js";
import { useModalKeys } from "../lib/useModalKeys.js";
import { useDismissTransition } from "../lib/useDismissTransition.js";
import { useFocusTrap } from "../lib/useFocusTrap.js";
import { useSegmentIndicator } from "../lib/useSegmentIndicator.js";
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
  const seq = useRef(0);

  const githubOk = !!p.integrations?.github.available;
  const linearOk = !!(p.integrations?.linear.configured && p.integrations.linear.valid !== false);
  const MODES: Array<{ key: Mode; label: string; enabled: boolean; hint?: string }> = [
    { key: "direct", label: t("workerSpawnModal.modeDirect"), enabled: true },
    { key: "github", label: "GitHub", enabled: githubOk, hint: t("workerSpawnModal.githubHint") },
    { key: "linear", label: "Linear", enabled: linearOk, hint: t("workerSpawnModal.linearHint") },
  ];
  const sourceMode = mode === "github" || mode === "linear";
  const seg = useSegmentIndicator(mode); // bg pill that slides over the mode segments

  useEffect(() => {
    if (!sourceMode || !p.searchSource || selected) return;
    const mine = ++seq.current;
    setSearching(true);
    const t = setTimeout(() => {
      p.searchSource!(mode, q)
        .then((items) => { if (seq.current === mine) { setResults(items); setSearching(false); } })
        .catch(() => { if (seq.current === mine) { setResults([]); setSearching(false); } });
    }, 250);
    return () => clearTimeout(t);
  }, [q, mode, selected]);

  const switchMode = (m: Mode) => { setMode(m); setSelected(null); setQ(""); setResults([]); };
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
      onClick={dismiss}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("workerSpawnModal.title")}
        className={cn("w-[520px] rounded-xl border border-line bg-surface p-5", closing ? "motion-safe:animate-[dialog-out_140ms_ease-in]" : "motion-safe:animate-[dialog-in_180ms_ease-out]")}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 text-[14px] font-semibold">{t("workerSpawnModal.title")}</div>
        <div className="mb-3 font-mono text-[11px] text-muted">repo · {p.repo}</div>

        {/* Source mode — write directly / GitHub issues·PRs / Linear tickets */}
        <div ref={seg.containerRef} className="relative mb-3 flex gap-1 rounded-[var(--radius)] border border-line bg-ink/40 p-1">
          {seg.rect && (
            <div
              className="pointer-events-none absolute inset-y-1 rounded-[6px] bg-raised shadow-sm transition-[left,width] duration-200 ease-out motion-reduce:transition-none"
              style={{ left: seg.rect.left, width: seg.rect.width }}
            />
          )}
          {MODES.map((m) => (
            <button
              key={m.key}
              data-seg={m.key}
              disabled={!m.enabled}
              title={m.enabled ? undefined : m.hint}
              onClick={() => switchMode(m.key)}
              className={cn(
                "relative z-10 flex-1 rounded-[6px] px-2 py-1.5 text-[12px] font-medium transition-colors",
                mode === m.key ? "text-fg" : "text-muted hover:text-fg-dim",
                !m.enabled && "cursor-not-allowed opacity-40 hover:text-muted",
              )}
            >
              {m.label}
            </button>
          ))}
        </div>

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
                  <option key={ef} value={ef}>{t("workerSpawnModal.effortOption", { effort: ef })}</option>
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
                  />
                  {focused && (searching || results.length > 0 || q.trim().length > 0) && (
                    // onMouseDown preventDefault: prevents the dropdown from closing first on input blur when a result is clicked, which would swallow the click.
                    <div className="max-h-44 overflow-y-auto rounded-[var(--radius)] border border-line bg-ink/40" onMouseDown={(e) => e.preventDefault()}>
                      {searching && results.length === 0 && <div className="px-2.5 py-1.5 text-[11px] text-muted">{t("workerSpawnModal.searching")}</div>}
                      {!searching && results.length === 0 && q.trim().length > 0 && <div className="px-2.5 py-1.5 text-[11px] text-muted">{t("workerSpawnModal.noResults")}</div>}
                      {results.map((it) => (
                        <button
                          key={`${it.provider}:${it.id}`}
                          onClick={() => pickSource(it)}
                          className="flex w-full items-baseline gap-2 px-2.5 py-1.5 text-left text-[12px] hover:bg-accent/10"
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
