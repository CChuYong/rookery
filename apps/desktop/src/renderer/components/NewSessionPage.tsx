import { useCallback, useEffect, useMemo, useState } from "react";
import { Folder, X, AlertTriangle, FolderGit2 } from "lucide-react";
import type { AuthStatus } from "@daemon/core/auth-status.js";
import { Composer } from "./Composer.js";
import type { SlashCommand } from "./Composer.js";
import type { BrowseResult } from "../types/rookery.js";
import { cn } from "../lib/cn.js";
import { useT } from "../i18n/provider.js";
import { baseName } from "../lib/path.js";
import { useDraftStore } from "../store/drafts.js";
import { useStore } from "../store/store.js";
import { Select, Input } from "../ui/input.js";
import { EFFORTS, codexDefaultEffort, codexEffortsFor, effortLabelKey, effortSupported } from "../lib/models.js";

// New master session — full page (entire main area). The input field is identical to the chat composer (markdown, file attachments, @ prefill, / skills).
// Start with it empty for an empty session. @ and / operate live against the repo/folder (cwd) picked below (if none selected, the daemon's default cwd).

// Fixed draft-store key for this page's composer — unlike conversation composers there's only ever one New Session page, not one per id.
// Exported so App's startSession can restore/clear it around session.create (audit #5).
export const NEW_SESSION_DRAFT_KEY = "newSession";

export function NewSessionPage(p: {
  repos: Array<{ name: string; path: string }>;
  defaultModel: string;
  defaultEffort: string;
  codexDefaultModel?: string; // placeholder shown in the free-text model field when provider === "codex" (daemon-side default, settings.codexMasterModel)
  onStart: (opts: { cwd?: string; prompt?: string; model?: string; effort: string; provider?: string }) => void;
  onClose?: () => void; // if absent, hide the close button (when shown as the default screen with no session)
  browseDir?: (dir: string, cwd?: string) => Promise<BrowseResult>; // @ file autocomplete (relative to the selected cwd)
  loadCommands?: (cwd?: string) => Promise<SlashCommand[]>; // / skill candidates (relative to the selected cwd)
  onAttachFile?: () => Promise<string | null>;
  onDropFiles?: (files: File[]) => string[];
  authStatus?: AuthStatus | null; // first-run guard: when method === "none" the SDK can't run, so warn before the user sends
  onOpenSettings?: () => void;
  defaultFolder?: string; // configured default session cwd (settings.defaultSessionCwd) — shown when no folder is picked
  onRegisterRepo?: () => void; // opens RepoModal (audit #58) — shown in the empty-repo state in place of the (hidden) repo picker
}): JSX.Element {
  const t = useT();
  const [cwd, setCwd] = useState("");
  const [model, setModel] = useState(p.defaultModel);
  const [effort, setEffort] = useState(p.defaultEffort);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  // Agent backend for this new session. Default "claude" (wire-minimal: onStart sends `undefined` for claude and
  // only an explicit value for "codex" — same idiom as WorkerSpawnModal's provider selector).
  const [provider, setProvider] = useState<"claude" | "codex">("claude");
  // Free-text codex model — kept separate from `model` so switching provider back and forth doesn't clobber
  // either field's last value (same idiom as WorkerSpawnModal's codexModel state).
  const [codexModel, setCodexModel] = useState("");
  const isCodex = provider === "codex";
  const codexModels = useStore((s) => s.codexModels); // codex catalog from codex.models.list; null = couldn't fetch → free-text fallback

  // Preserve the typed prompt across page close/reopen and session-create failures — same draft-store wiring as ConversationPane,
  // but with a fixed key since this page isn't per-session. Read non-reactively (only at mount); this page remounts (key={pageId}) on reopen.
  const initialText = useMemo(() => useDraftStore.getState().byPage[NEW_SESSION_DRAFT_KEY] ?? "", []);
  const onDraftChange = useCallback((text: string) => useDraftStore.getState().setDraft_(NEW_SESSION_DRAFT_KEY, text), []);

  // When the selected repo/folder (cwd) changes, reload that cwd's skills (live). If none selected, the daemon's default cwd.
  // Codex has no slash-command catalog, so skip the probe entirely for a codex new session (finding [6]) — otherwise the
  // composer would offer Claude commands codex can't run, and the probe spawns a wasted Claude query.
  useEffect(() => {
    if (!p.loadCommands || isCodex) { setCommands([]); return; }
    let live = true;
    void p.loadCommands(cwd || undefined).then((c) => { if (live) setCommands(c); }).catch(() => { if (live) setCommands([]); });
    return () => { live = false; };
  }, [cwd, isCodex]);

  const start = (prompt: string): void =>
    p.onStart({
      cwd: cwd.trim() || undefined,
      prompt: prompt.trim() || undefined,
      model: isCodex ? codexModel.trim() || undefined : model,
      effort,
      provider: isCodex ? "codex" : undefined, // wire-minimal: absent means claude
    });
  const pick = async (): Promise<void> => { const dir = await window.rookery.pickDirectory(); if (dir) setCwd(dir); };
  const browseDir = p.browseDir ? (dir: string) => p.browseDir!(dir, cwd || undefined) : undefined;
  const folderName = cwd ? baseName(cwd) : (p.defaultFolder ? baseName(p.defaultFolder) : t("newSessionPage.defaultFolder"));

  // Working-folder picker inserted at the left of the composer's control row (on the same line as the model/effort and send button).
  const folderPicker = (
    <button onClick={() => void pick()} title={cwd || p.defaultFolder || t("newSessionPage.daemonDefaultFolder")} className="flex max-w-[200px] items-center gap-1.5 rounded-lg border border-line px-2 py-1 text-[11px] text-fg-dim transition-colors hover:bg-raised hover:text-fg">
      <Folder size={12} className="shrink-0" /> <span className="truncate">{folderName}</span>
    </button>
  );

  // Agent-backend selector (WorkerSpawnModal idiom, reused i18n keys). Rendered in the same leftSlot row as the
  // folder picker — the Composer's own model/effort controls live inside a shared component (not a standalone
  // <Select> like the modal), so rather than changing Composer's API, codex's free-text model field + its own
  // effort <Select> render here too and the Composer's `controls` prop is omitted entirely when codex (see below).
  const providerSelector = (
    <Select size="xs" className="w-auto min-w-0 text-fg-dim" value={provider} onChange={(e) => setProvider(e.target.value as "claude" | "codex")} title={t("workerSpawnModal.provider")}>
      <option value="claude">{t("workerSpawnModal.providerClaude")}</option>
      <option value="codex">{t("workerSpawnModal.providerCodex")}</option>
    </Select>
  );
  // Codex effort options come from the selected model's catalog entry when the catalog was fetched; unknown model
  // or no catalog (null) falls back to the generic EFFORTS vocabulary so the selector is never empty.
  const codexEfforts = codexModels != null ? codexEffortsFor(codexModel || p.codexDefaultModel || "", codexModels) : null;
  const codexEffortOptions: readonly string[] = codexEfforts && codexEfforts.length > 0 ? codexEfforts : EFFORTS;
  // Re-derive effort on provider/model/catalog change so a stale Claude level (e.g. 'max') that isn't a
  // valid codex option can't linger — it would render the select blank and be submitted as 'max' (finding
  // [23], same as WorkerSpawnModal). Snap to the model's catalog default, else the first valid option.
  useEffect(() => {
    if (!isCodex || codexEffortOptions.includes(effort)) return;
    const preferred = (codexModels ? codexDefaultEffort(codexModel || p.codexDefaultModel || "", codexModels) : "") || codexEffortOptions[0];
    if (preferred && preferred !== effort) setEffort(preferred);
  }, [isCodex, codexModel, codexModels]); // eslint-disable-line react-hooks/exhaustive-deps
  // codex model field: a catalog-driven dropdown when codex.models.list succeeded, else today's free text
  // (daemon default, settings.codexMasterModel, when empty).
  const codexControls = isCodex && (
    <>
      {codexModels != null ? (
        <Select
          size="xs"
          className="w-28 min-w-0 text-fg-dim"
          value={codexModel}
          onChange={(e) => {
            const nm = e.target.value;
            setCodexModel(nm);
            const de = codexDefaultEffort(nm, codexModels);
            if (de) setEffort(de);
          }}
          title={t("composer.modelTitle")}
        >
          {/* Task 4 fold-in (Task 3 review Minor #1): a fresh open with the catalog present used to render this
              <Select value=""> blank. This leading "" option shows a "use default" label instead — the daemon
              applies the codexMasterModel settings default when the session's model is empty, so we deliberately
              do NOT auto-pick a catalog model here (that would silently override the default). */}
          <option value="">{p.codexDefaultModel ? t("settings.codexModelDefaultOptionWith", { model: p.codexDefaultModel }) : t("settings.codexModelDefaultOption")}</option>
          {codexModels.map((m) => (
            <option key={m.id} value={m.id}>{m.displayName}</option>
          ))}
          {!codexModels.some((m) => m.id === codexModel) && codexModel && <option value={codexModel}>{codexModel}</option>}
        </Select>
      ) : (
        <Input size="xs" className="w-28 min-w-0 text-fg-dim" value={codexModel} onChange={(e) => setCodexModel(e.target.value)} placeholder={p.codexDefaultModel} title={t("composer.modelTitle")} />
      )}
      {effortSupported(codexModel || p.codexDefaultModel || "") && (
        <Select size="xs" className="min-w-0 text-fg-dim" value={effort} onChange={(e) => setEffort(e.target.value)} title={t("composer.effortTitle")}>
          {codexEffortOptions.map((ef) => (
            <option key={ef} value={ef}>{t(effortLabelKey(ef))}</option>
          ))}
        </Select>
      )}
    </>
  );

  return (
    <>
      <div className="drag flex h-11 shrink-0 items-center gap-2 border-b border-line px-5 text-[13px]">
        <span className="font-semibold tracking-[-0.01em]">{t("newSessionPage.title")}</span>
        {p.onClose && (
          <button onClick={p.onClose} aria-label={t("common.close")} className="no-drag ml-auto rounded-md p-1.5 text-muted transition-colors hover:bg-raised hover:text-fg-dim">
            <X size={16} />
          </button>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6">
        <div className="mx-auto flex w-full max-w-[680px] flex-1 flex-col justify-center gap-6 py-10">
          {/* First-run / auth-blocked guard: with no API key and no Claude login, every turn would fail — guide the user before they send. */}
          {p.authStatus?.method === "none" && (
            <div className="flex items-start gap-3 rounded-xl border border-run/30 bg-run/10 px-4 py-3 text-left">
              <AlertTriangle size={18} className="mt-0.5 shrink-0 text-run" />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-semibold text-fg">{t("newSessionPage.authBlockedTitle")}</div>
                <p className="mt-0.5 text-[12px] leading-relaxed text-fg-dim">{t("newSessionPage.authBlockedBody")}</p>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <code className="rounded bg-ink px-1.5 py-0.5 font-mono text-[11px] text-fg-dim">claude login</code>
                  {p.onOpenSettings && (
                    <button onClick={p.onOpenSettings} className="text-[12px] font-medium text-accent transition-colors hover:text-accent-hi">
                      {t("newSessionPage.authBlockedCta")}
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
          <div className="text-center text-[26px] font-semibold tracking-[-0.02em] text-fg-dim">
            <span className="breathe inline-block text-accent">✻</span> {t("newSessionPage.heading")}
          </div>

          <Composer
            onSend={start}
            autoFocus
            allowEmpty // start with it empty for an empty session
            sendLabel={t("newSessionPage.sendLabel")}
            placeholder={t("newSessionPage.placeholder")}
            controls={isCodex ? undefined : { model, effort, editable: true, onModel: setModel, onEffort: setEffort }}
            commands={commands}
            browseDir={browseDir}
            onAttachFile={p.onAttachFile}
            onDropFiles={p.onDropFiles}
            onEscape={p.onClose}
            leftSlot={<>{folderPicker}{providerSelector}{codexControls}</>}
            className="rounded-2xl border-line bg-surface/70 px-3 py-2.5"
            initialText={initialText}
            onDraftChange={onDraftChange}
          />

          {p.repos.length > 0 ? (
            <div className="flex flex-col items-center gap-2">
              <p className="text-[11px] text-muted">{t("newSessionPage.pickRepoFolder")}</p>
              <div className="flex flex-wrap justify-center gap-1.5">
                {p.repos.map((r) => (
                  <button
                    key={r.name}
                    title={r.path}
                    onClick={() => setCwd(r.path)}
                    className={cn("flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12px] transition-[color,background-color,border-color,transform] duration-150 active:scale-[0.97] motion-reduce:active:scale-100",
                      cwd === r.path ? "border-accent/60 bg-accent/15 text-fg" : "border-line bg-ink/40 text-fg-dim hover:bg-raised hover:text-fg")}
                  >
                    <Folder size={12} /> {r.name}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            // Empty-repo CTA (audit #58) — the repo picker used to just vanish here, leaving a blank space below
            // the composer with no hint that registering a repo is the prerequisite for spawning workers.
            p.onRegisterRepo && (
              <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line px-5 py-4 text-center">
                <FolderGit2 size={18} className="text-muted" />
                <p className="text-[12.5px] font-medium text-fg-dim">{t("newSessionPage.noReposTitle")}</p>
                <p className="max-w-[320px] text-[11.5px] leading-relaxed text-muted">{t("newSessionPage.noReposBody")}</p>
                <button
                  onClick={p.onRegisterRepo}
                  className="mt-1 flex items-center gap-1.5 rounded-lg border border-dashed border-line px-2.5 py-1.5 text-[12px] text-muted transition-colors hover:border-accent/40 hover:text-fg-dim"
                >
                  <Folder size={12} /> {t("newSessionPage.registerRepo")}
                </button>
              </div>
            )
          )}
        </div>
      </div>
    </>
  );
}
