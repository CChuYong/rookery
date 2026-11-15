import type { ImageRef } from "@daemon/core/image-input.js";
import { checkImageBatch, importImage, isImageFile, ImageImportError } from "../lib/image-import.js";
import { getImageClient } from "../lib/image-client.js";
import { ImageAttachments } from "./ImageAttachments.js";
import { useEffect, useRef, useState } from "react";
import type { DragEvent, ReactNode } from "react";
import type { CommandAction } from "@daemon/core/capabilities/commands.js";
import { Paperclip, Square, Loader2, MessageCircleQuestion, LifeBuoy } from "lucide-react";
import { baseName as basename } from "../lib/path.js";
import type { BrowseResult } from "../types/rookery.js";
import { Button } from "../ui/button.js";
import { Input, Select } from "../ui/input.js";
import { EFFORTS, codexDefaultEffort, codexEffortsFor, effortLabelKey, effortSupported } from "../lib/models.js";
import { useStore } from "../store/store.js";
import { cn } from "../lib/cn.js";
import { useT } from "../i18n/provider.js";
import type { SpeedObservation, SpeedPreference } from "@daemon/core/speed.js";
import { SpeedControl, SpeedMismatchDot, speedState } from "./SpeedControl.js";
import { ChromeMenu, ComposerFooter, COMPOSER_BOX, MenuField, SendButton } from "./ComposerChrome.js";
import { Tooltip } from "./Tooltip.js";
import { PromptEditor } from "./PromptEditor.js";
import type { SlashCommand, PromptEditorHandle } from "./PromptEditor.js";

// After Stop is clicked, how long the worker may stay busy before we surface the "Recover" escalation. A soft
// interrupt normally lands in ~1-2s; past this, the turn is almost certainly wedged in a long tool call/workflow.
const STUCK_STOP_MS = 6000;

// The trigger reads "Opus 4.8 · High" (T3's convention); the live model list labels some models "Claude …".
export const shortModelLabel = (label: string): string => label.replace(/^Claude\s+/, "");

// Model/effort controls at the bottom of the input box. editable=true means selectable (master session, before spawn),
// false means a read-only badge (running worker — model is fixed at spawn time).
export interface ComposerControls {
  speed?: SpeedPreference | null;
  defaultSpeed?: SpeedPreference;
  speedPending?: boolean;
  speedObservation?: SpeedObservation;
  speedLastObservation?: SpeedObservation;
  onSpeed?: (speed: SpeedPreference | null) => void;
  provider?: string; // "codex" → the model dropdown is sourced from the codex model/list catalog + per-model efforts (like the spawn surfaces); absent/"claude" → the Claude models list. Codex falls back to the Claude list only if the catalog couldn't be fetched.
  model: string;
  effort?: string; // if absent, hide the effort select/badge (a running worker can't change effort live)
  permissionMode?: string; // if absent, hide the permission-mode select. Master + worker both expose it; absent only for read-only badges.
  permissionModes?: readonly string[]; // restrict the offered modes (worker = bypass+plan only). Defaults to all 4 (PERMISSION_MODES, master).
  editable: boolean;
  onModel?: (m: string) => void;
  onEffort?: (e: string) => void;
  onPermissionMode?: (m: string) => void;
}

// Permission modes to expose in the selector (master). Labels are i18n (literal keys → passes the used-keys test).
export const PERMISSION_MODES = ["bypassPermissions", "default", "plan", "acceptEdits"] as const;
export function permLabel(mode: string, t: (k: string) => string): string {
  switch (mode) {
    case "bypassPermissions": return t("composer.permBypass");
    case "default": return t("composer.permDefault");
    case "plan": return t("composer.permPlan");
    case "acceptEdits": return t("composer.permAcceptEdits");
    default: return mode;
  }
}

export type { SlashCommand };

export function matchCommandAction(text: string, commands: SlashCommand[]): { candidate: SlashCommand; argument?: string } | null {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  const name = match[1]!.toLowerCase();
  const candidate = commands.find((command) => {
    const names = [command.name, ...(command.aliases ?? [])].map((value) => value.replace(/^\/+/, "").toLowerCase());
    return names.includes(name);
  });
  if (!candidate) return null;
  const argument = match[2]?.trim();
  return { candidate, ...(argument ? { argument } : {}) };
}

// Chat input composer (shared by master/worker conversations + new session). Bundles markdown shortcuts, @file-mention and /skill popups,
// file attachment / drag-drop, and model/effort controls into one box. The outer chrome (bottom bar vs card) is
// wrapped by the caller — this only renders the inner input box.
export interface ComposerProps {
  onSend: (text: string, images?: ImageRef[]) => void | Promise<void>;
  onSideSend?: (text: string, images?: ImageRef[]) => void | Promise<void>; // redirect the current draft into an independent read-only Side conversation
  disabled?: boolean;
  placeholder?: string;
  controls?: ComposerControls;
  onAttachFile?: () => Promise<string | null>;
  onDropFiles?: (files: File[]) => string[]; // dropped Files → array of absolute paths (attachment)
  browseDir?: (dir: string) => Promise<BrowseResult>; // @ path autocomplete: list a directory (if absent, the @ popup is disabled)
  commands?: SlashCommand[];
  onCommandAction?: (action: CommandAction, argument?: string) => void;
  busy?: boolean; // turn in progress → the send button becomes a stop button
  onStop?: () => void;
  onRecover?: () => void | Promise<void>; // worker only: a soft interrupt (onStop) can't stop a turn wedged in a long tool call / Dynamic Workflow. When provided, a "Recover" affordance appears if Stop doesn't settle in time (worker.recover — hard-kill + resume in place).
  leftSlot?: ReactNode; // per-page widget to insert at the left of the controls row (e.g. the new session's folder picker)
  menuRows?: ReactNode; // extra rows at the top of the model menu (e.g. the new session's agent backend, codex model/effort)
  menuSummary?: string; // trigger text when the caller owns the model fields (no `controls`)
  menuSide?: "top" | "bottom"; // where the model menu opens (default above — the conversation composer sits at the bottom)
  onEscape?: () => void; // Esc when no popup is open (e.g. close the new session). Esc with a popup open only closes the popup.
  allowEmpty?: boolean; // allow sending empty input (new session: empty means start a blank session)
  autoFocus?: boolean;
  sendLabel?: string; // send button aria-label (default "Send"; "Start" for a new session)
  className?: string; // override outer box styling (card look, etc.)
  initialImages?: ImageRef[];
  initialText?: string; // seed the editor with this draft on mount (restore after tab/session switch). Changes flow through onDraftChange.
  onDraftChange?: (text: string, images?: ImageRef[]) => void; // called whenever the serialized input changes — the caller persists the draft
}

export function Composer({
  onSend,
  onSideSend,
  disabled = false,
  placeholder,
  controls,
  onAttachFile,
  onDropFiles,
  browseDir,
  commands = [],
  onCommandAction,
  busy = false,
  onStop,
  onRecover,
  leftSlot,
  menuRows,
  menuSummary,
  menuSide = "top",
  onEscape,
  allowEmpty = false,
  autoFocus = false,
  sendLabel,
  className,
  initialImages = [],
  initialText,
  onDraftChange,
}: ComposerProps): JSX.Element {
  const t = useT();
  const placeholderText = placeholder ?? t("composer.placeholder");
  const sendLabelText = sendLabel ?? t("composer.sendLabel");
  const [text, setText] = useState(initialText ?? ""); // current message serialized from the editor (derived, for popup/empty-state/send decisions)
  const [images, setImages] = useState<ImageRef[]>(initialImages);
  const imagesRef = useRef(images); imagesRef.current = images;
  const [importing, setImporting] = useState(false);
  const importLock = useRef(false);
  const [picking, setPicking] = useState(false);
  const pickerLock = useRef(false);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const disabledRef = useRef(disabled); disabledRef.current = disabled;
  const draftGeneration = useRef(0);
  const [error, setError] = useState<string>();
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const importFiles = async (files: Parameters<typeof importImage>[0][]) => {
    if (!files.length || disabledRef.current || importLock.current || sendingRef.current) return;
    importLock.current = true; setImporting(true); setError(undefined);
    try {
      checkImageBatch(imagesRef.current, files.map(file => 'size' in file ? file.size : file.byteLength));
      for (const file of files) {
        const image = await importImage(file, getImageClient());
        if (!alive.current) return;
        setImages(current => [...current, image]);
      }
    } catch (err) {
      if (alive.current) setError(t(err instanceof ImageImportError ? `images.${err.reason}` : "images.failed"));
    } finally { importLock.current = false; if (alive.current) setImporting(false); }
  };
  const models = useStore((s) => s.models); // live Claude model list (static fallback if absent)
  const codexModels = useStore((s) => s.codexModels); // codex model/list catalog (null when unfetched)
  // When the conversation runs on codex AND the catalog is available, source the model dropdown + per-model
  // effort options from it (parity with the spawn/new-session/automation/settings pickers). Otherwise (claude,
  // or codex with an unfetched catalog) fall back to the Claude models list + generic EFFORTS — unchanged behavior.
  const codexActive = controls?.provider === "codex" && codexModels != null;
  // Codex conversation with an unfetched catalog → free-text model input (parity with the spawn/new-session/
  // automation/settings surfaces + the design's null-catalog contract), NOT the Claude dropdown, which would
  // otherwise offer Claude-only ids a codex turn rejects (finding [11]/[14]).
  const codexFreeText = controls?.provider === "codex" && codexModels == null;
  const modelList: ReadonlyArray<{ id: string; label: string }> = codexActive
    ? codexModels!.map((m) => ({ id: m.id, label: m.displayName }))
    : models;
  const codexEfforts = codexActive && controls ? codexEffortsFor(controls.model, codexModels) : null;
  const effortOptions: readonly string[] = codexEfforts && codexEfforts.length > 0 ? codexEfforts : EFFORTS;
  const [dragOver, setDragOver] = useState(false);
  const promptRef = useRef<PromptEditorHandle>(null);
  // Aborting a turn isn't instant (the SDK has to drain buffered output), and the status only flips a moment later — so without
  // local feedback a Stop click looks ignored and gets re-clicked. Show the button as a disabled spinner from click until the turn
  // actually ends (busy flips false, which also swaps the stop button back to send → resets this).
  const [stopping, setStopping] = useState(false);
  useEffect(() => { if (!busy) setStopping(false); }, [busy]);
  // Escalation: a soft interrupt (onStop) can't stop a worker wedged in a long tool call / Dynamic Workflow, so
  // the Stop spinner would spin forever. Once Stop is clicked and the worker is STILL busy STUCK_STOP_MS later,
  // reveal a "Recover" affordance (onRecover → worker.recover: hard-kill + resume in place). Master has no
  // onRecover, so this never fires for it (its interrupt lands normally anyway).
  const [stuck, setStuck] = useState(false);
  // Recover is a request with a result: show it in flight and swallow repeat clicks until it settles (audit #34).
  const [recovering, setRecovering] = useState(false);
  const recover = async (): Promise<void> => {
    if (!onRecover || recovering) return;
    setRecovering(true);
    try { await onRecover(); } catch { /* the caller reports the failure */ } finally { if (alive.current) setRecovering(false); }
  };
  useEffect(() => {
    if (!busy) { setStuck(false); return; } // turn ended → clear the escalation for the next turn
    if (!stopping || !onRecover) return; // only after Stop was clicked, and only where recover is available (workers)
    const timer = setTimeout(() => setStuck(true), STUCK_STOP_MS);
    return () => clearTimeout(timer);
  }, [busy, stopping, onRecover]);

  // Notify the caller to persist the draft whenever the serialized input changes. Skip the first render (mount) —
  // so we don't write the seed value straight back (in particular, avoid wiping a saved draft with empty input).
  const draftMounted = useRef(false);
  useEffect(() => {
    if (!draftMounted.current) { draftMounted.current = true; return; }
    if (images.length) onDraftChange?.(text, images); else onDraftChange?.(text);
  }, [text, images, onDraftChange]);

  const submitTo = async (side = false) => {
    if (disabledRef.current || importing || importLock.current || sendingRef.current) return;
    const msg = (promptRef.current?.getText() ?? "").trim();
    if (!msg && !images.length && (!allowEmpty || side)) return;
    const command = !side && onCommandAction ? matchCommandAction(msg, commands) : null;
    if (command && command.candidate.action.type !== "insert-prompt") {
      if (images.length) { setError(t("images.command")); return; }
      if (command.candidate.action.type === "open-panel" && !command.argument) return;
      draftGeneration.current++;
      onCommandAction?.(command.candidate.action, command.argument);
      promptRef.current?.clear(); return;
    }
    const send = side ? onSideSend : onSend;
    if (!send) return;
    draftGeneration.current++;
    sendingRef.current = true;
    setSending(true); setError(undefined);
    try {
      const result = images.length ? send(msg, images) : send(msg);
      if (result) await result;
      // Acceptance may navigate/unmount. The owning draft is cleared by the send path in that case.
      if (alive.current) { promptRef.current?.clear(); setImages([]); }
    } catch (err) {
      // The one place a failed send is reported: inline, next to the kept draft (callers don't toast it too, audit #32).
      if (alive.current) setError(t("composer.sendFailed", { reason: err instanceof Error ? err.message : String(err) }));
    }
    finally { sendingRef.current = false; if (alive.current) setSending(false); }
  };
  const submit = () => { void submitTo(); };
  const submitSide = () => { void submitTo(true); };

  // Insert paths as Lexical-owned inline chips (show only the filename, serialize as @path).
  const addAttachments = (paths: string[]) => {
    const valid = paths.filter(Boolean);
    if (!valid.length) return;
    promptRef.current?.insertFiles(valid.map((path) => ({ path, name: basename(path) })));
  };

  // File selection → attach.
  const attach = async () => {
    if (disabledRef.current || sendingRef.current || importLock.current || pickerLock.current) return;
    pickerLock.current = true; setPicking(true);
    const generation = draftGeneration.current;
    const canApply = () => alive.current && !disabledRef.current && !sendingRef.current && generation === draftGeneration.current;
    try {
      // The native bridge reads only its dialog selection. Old selections cannot mutate a submitted draft.
      const selected = window.rookery?.pickAttachment
        ? await window.rookery.pickAttachment()
        : onAttachFile ? await onAttachFile().then(path => path ? {path} : null) : null;
      if (!canApply() || !selected) return;
      if ('path' in selected) addAttachments([selected.path]);
      else await importFiles([selected]);
    } catch (error) {
      if (canApply()) {
        const message = error instanceof Error ? error.message : "";
        setError(t(/unsupported/i.test(message) ? "images.type" : /size limit/i.test(message) ? "images.size" : "images.failed"));
      }
    } finally {
      pickerLock.current = false;
      if (alive.current) setPicking(false);
    }
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault(); setDragOver(false);
    if (disabled || sending || importing) return;
    const files = Array.from(event.dataTransfer.files);
    void importFiles(files.filter(isImageFile));
    const paths = files.filter(file => !isImageFile(file));
    if (paths.length && onDropFiles) addAttachments(onDropFiles(paths));
  };

  const hasText = !!text.trim() || images.length > 0;
  const editable = !!controls?.editable;
  const modelLabel = controls ? shortModelLabel(modelList.find((m) => m.id === controls.model)?.label ?? controls.model) : "";
  const showEffort = controls?.effort !== undefined && effortSupported(controls.model);
  const speed = controls?.speed !== undefined && controls ? speedState(t, { speed: controls.speed, defaultSpeed: controls.defaultSpeed, provider: controls.provider, model: controls.model, pendingNextTurn: controls.speedPending, observation: controls.speedObservation, lastObservation: controls.speedLastObservation }, codexModels) : null;
  // The trigger names model · effort, and only the choices that differ from the default (audit #85): a permission mode
  // other than Bypass, and Fast.
  const summary = controls
    ? [modelLabel, showEffort ? t(effortLabelKey(controls.effort!)) : null,
       controls.permissionMode && controls.permissionMode !== "bypassPermissions" ? permLabel(controls.permissionMode, t) : null,
       speed?.requested === "fast" ? t("speed.fast") : null].filter(Boolean).join(" · ")
    : menuSummary ?? "";

  // Model, effort, permission mode and speed in one menu (IDE skill: "permission mode lives in the model menu").
  const menuFields = controls && editable ? (
    <>
      <MenuField label={t("composer.fieldModel")}>
        {codexFreeText ? (
          <Input size="sm" className="w-full" title={t("composer.modelTitle")} value={controls.model} disabled={disabled} onChange={(e) => controls.onModel?.(e.target.value)} />
        ) : (
          <Select
            size="sm"
            className="w-full"
            title={t("composer.modelTitle")}
            value={controls.model}
            disabled={disabled}
            onChange={(e) => {
              const m = e.target.value;
              controls.onModel?.(m);
              // codex: picking a model pre-selects that model's default reasoning effort (parity with the spawn pickers).
              if (codexActive) { const de = codexDefaultEffort(m, codexModels); if (de) controls.onEffort?.(de); }
            }}
          >
            {modelList.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
            {!modelList.some((m) => m.id === controls.model) && controls.model && <option value={controls.model}>{controls.model}</option>}
          </Select>
        )}
      </MenuField>
      {showEffort && (
        <MenuField label={t("composer.fieldEffort")}>
          <Select size="sm" className="w-full" title={t("composer.effortTitle")} value={controls.effort} disabled={disabled} onChange={(e) => controls.onEffort?.(e.target.value)}>
            {effortOptions.map((ef) => (
              <option key={ef} value={ef}>{t(effortLabelKey(ef))}</option>
            ))}
          </Select>
        </MenuField>
      )}
      {controls.permissionMode !== undefined && (
        <MenuField label={t("composer.fieldPermission")}>
          <Select size="sm" className="w-full" title={t("composer.permTitle")} value={controls.permissionMode} disabled={disabled} onChange={(e) => controls.onPermissionMode?.(e.target.value)}>
            {(controls.permissionModes ?? PERMISSION_MODES).map((pm) => (
              <option key={pm} value={pm}>{permLabel(pm, t)}</option>
            ))}
          </Select>
        </MenuField>
      )}
      {controls.speed !== undefined && (
        <MenuField label={t("speed.label")} hint={t("speed.hint")}>
          <SpeedControl variant="field" hideLabel speed={controls.speed} defaultSpeed={controls.defaultSpeed} provider={controls.provider} model={controls.model} pendingNextTurn={controls.speedPending} observation={controls.speedObservation} lastObservation={controls.speedLastObservation} onChange={controls.onSpeed} disabled={disabled} />
        </MenuField>
      )}
    </>
  ) : null;
  const modelMenu = (menuFields || menuRows) ? (
    <span className="flex min-w-0 items-center">
      <ChromeMenu summary={summary} ariaLabel={`${t("composer.modelMenu")}: ${summary}`} side={menuSide} disabled={disabled}>
        {menuRows}
        {menuFields}
      </ChromeMenu>
      {speed?.degraded && <SpeedMismatchDot title={speed.explanation ?? t("speed.mismatch")} className="ml-0" />}
    </span>
  ) : controls ? (
    // Read-only badge (a fixed model, e.g. a stopped worker): plain text, no menu.
    <span className="inline-flex min-w-0 items-center gap-1.5 truncate px-1.5 text-meta text-muted" title={t("composer.fixedModelTitle")}>
      <span className="truncate text-fg-dim">{modelList.find((m) => m.id === controls.model)?.label ?? controls.model}</span>
      {showEffort && (
        <>
          <span className="h-3 w-px shrink-0 bg-line" aria-hidden />
          <span>{t(effortLabelKey(controls.effort!))}</span>
        </>
      )}
    </span>
  ) : null;

  const sendReason = disabled ? undefined : importing ? t("images.importing") : !hasText && !allowEmpty ? t("composer.sendEmpty") : undefined;
  const showStop = busy && onStop && !disabled;
  // A read-only composer at rest (an ended worker, a Slack session) drops its dead input buttons so it doesn't look
  // writable; the placeholder says why (audit #117).
  const inert = disabled && !busy;

  return (
    <div
      className={cn(
        // T3's composer well — a quiet surface box, a neutral focus edge (no orange glow/ring).
        COMPOSER_BOX,
        "gap-2 px-3 py-2",
        dragOver ? "border-accent/70 bg-accent/5" : "border-line",
        className,
      )}
      onDragOver={(e) => { if (!disabled && !sending) { e.preventDefault(); setDragOver(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false); }}
      onDrop={onDrop}
    >
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-lg border-2 border-dashed border-accent/60 bg-ink/70 text-ui font-medium text-accent">
          {t("composer.dropToAttach")}
        </div>
      )}
      <ImageAttachments images={images} onRemove={(index) => { if (!sending) setImages(current => current.filter((_,i) => i !== index)); }} />
      {importing && <div role="status" className="text-meta text-muted">{t("images.importing")}</div>}
      {error && <div role="alert" className="text-meta text-fail">{error}</div>}
      <PromptEditor
        ref={promptRef}
        initialText={initialText}
        onChange={setText}
        commands={images.length ? commands.filter(command => command.action.type === "insert-prompt") : commands}
        browseDir={browseDir}
        placeholder={placeholderText}
        disabled={disabled || sending}
        onPasteImages={(files) => void importFiles(files)}
        autoFocus={autoFocus}
        onSubmit={submit}
        onEscape={onEscape}
        onCommandAction={(action) => { if (images.length) setError(t("images.command")); else onCommandAction?.(action); }}
      />
      {/* One row: context and attach on the left, the model menu and the send actions pinned right — the send button
          never wraps onto a line of its own (audit #85). */}
      <ComposerFooter
        left={
          <>
            {leftSlot}
            {!inert && (onAttachFile || window.rookery?.pickAttachment) && (
              <Tooltip label={t("composer.attachFile")} align="start">
                <Button variant="ghost" size="iconSm" className="h-6 w-6" aria-label={t("composer.attachFile")} disabled={disabled || sending || importing || picking} onClick={() => void attach()}>
                  <Paperclip size={14} />
                </Button>
              </Tooltip>
            )}
          </>
        }
        right={
          <>
            {modelMenu}
            {onSideSend && !disabled && (
              <Tooltip label={hasText ? t("composer.sideQuestionHint") : t("composer.sideQuestionEmpty")} align="end">
                <Button variant="ghost" size="iconSm" className="h-6 w-6" aria-label={t("composer.sideQuestion")} disabled={sending || importing || !hasText} onClick={submitSide}>
                  <MessageCircleQuestion size={14} />
                </Button>
              </Tooltip>
            )}
            {/* Stop stays visible for the whole turn so an in-progress turn can always be aborted (audit #23). Once you type/attach
                something, Send appears alongside Stop (Stop first) so you can either abort the turn or queue the next message. When
                disabled (e.g. Slack readonly), the stop button is hidden. */}
            {showStop && (
              stuck && onRecover ? (
                // Interrupt didn't land — the turn is wedged. Turn the dead spinner into an actionable Recover
                // (worker.recover: hard-kill the stuck subprocess and resume the session in place → back to idle).
                <Button variant="danger" size="icon" className="h-[26px] w-[26px] rounded-md bg-raised" aria-label={t("composer.recover")} title={t("composer.recoverHint")} loading={recovering} onClick={() => void recover()}>
                  <LifeBuoy size={14} />
                </Button>
              ) : (
                <Button variant="danger" size="icon" className="h-[26px] w-[26px] rounded-md bg-raised" disabled={stopping} aria-label={t("composer.stop")} title={t("composer.stopHint")} onClick={() => { setStopping(true); onStop(); }}>
                  {stopping ? <Loader2 size={14} className="animate-spin" /> : <Square size={14} />}
                </Button>
              )
            )}
            {!inert && !(showStop && !hasText) && (
              // White-on-black send, like T3 — the accent stays off the send action entirely.
              <SendButton
                label={sendLabelText}
                hint={sendReason}
                loading={sending}
                disabled={disabled || importing || (!hasText && !allowEmpty)}
                onClick={submit}
              />
            )}
          </>
        }
      />
    </div>
  );
}
