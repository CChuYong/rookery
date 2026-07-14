import { useEffect, useRef, useState } from "react";
import type { DragEvent, ReactNode } from "react";
import type { CommandAction } from "@daemon/core/capabilities/commands.js";
import { Send, Paperclip, Square, Loader2, MessageCircleQuestion } from "lucide-react";
import { baseName as basename } from "../lib/path.js";
import { makeChip } from "../lib/mention-editor.js";
import type { BrowseResult } from "../types/rookery.js";
import { Button } from "../ui/button.js";
import { Select, Input } from "../ui/input.js";
import { EFFORTS, codexDefaultEffort, codexEffortsFor, effortLabelKey, effortSupported } from "../lib/models.js";
import { useStore } from "../store/store.js";
import { cn } from "../lib/cn.js";
import { useT } from "../i18n/provider.js";
import { PromptEditor } from "./PromptEditor.js";
import type { SlashCommand, PromptEditorHandle } from "./PromptEditor.js";

// Model/effort controls at the bottom of the input box. editable=true means selectable (master session, before spawn),
// false means a read-only badge (running worker — model is fixed at spawn time).
export interface ComposerControls {
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
  onSend: (text: string) => void;
  onSideSend?: (text: string) => void; // redirect the current draft into an independent read-only Side conversation
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
  leftSlot?: ReactNode; // per-page widget to insert at the left of the controls row (e.g. the new session's folder picker)
  onEscape?: () => void; // Esc when no popup is open (e.g. close the new session). Esc with a popup open only closes the popup.
  allowEmpty?: boolean; // allow sending empty input (new session: empty means start a blank session)
  autoFocus?: boolean;
  sendLabel?: string; // send button aria-label (default "Send"; "Start" for a new session)
  className?: string; // override outer box styling (card look, etc.)
  initialText?: string; // seed the editor with this draft on mount (restore after tab/session switch). Changes flow through onDraftChange.
  onDraftChange?: (text: string) => void; // called whenever the serialized input changes — the caller persists the draft
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
  leftSlot,
  onEscape,
  allowEmpty = false,
  autoFocus = false,
  sendLabel,
  className,
  initialText,
  onDraftChange,
}: ComposerProps): JSX.Element {
  const t = useT();
  const placeholderText = placeholder ?? t("composer.placeholder");
  const sendLabelText = sendLabel ?? t("composer.sendLabel");
  const [text, setText] = useState(initialText ?? ""); // current message serialized from the editor (derived, for popup/empty-state/send decisions)
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

  // Notify the caller to persist the draft whenever the serialized input changes. Skip the first render (mount) —
  // so we don't write the seed value straight back (in particular, avoid wiping a saved draft with empty input).
  const draftMounted = useRef(false);
  useEffect(() => {
    if (!draftMounted.current) { draftMounted.current = true; return; }
    onDraftChange?.(text);
  }, [text, onDraftChange]);

  const submit = () => {
    if (disabled) return;
    const msg = (promptRef.current?.getText() ?? "").trim();
    if (!msg && !allowEmpty) return;
    const command = onCommandAction ? matchCommandAction(msg, commands) : null;
    if (command && command.candidate.action.type !== "insert-prompt") {
      if (command.candidate.action.type === "open-panel" && !command.argument) return;
      onCommandAction?.(command.candidate.action, command.argument);
      promptRef.current?.clear();
      return;
    }
    onSend(msg);
    promptRef.current?.clear();
  };

  const submitSide = () => {
    if (disabled || !onSideSend) return;
    const msg = (promptRef.current?.getText() ?? "").trim();
    if (!msg) return;
    onSideSend(msg);
    promptRef.current?.clear();
  };

  // Insert paths as inline chips at the caret position (show only the filename, serialize as @path). Shared by button attach and drag-drop.
  const addAttachments = (paths: string[]) => {
    const valid = paths.filter(Boolean);
    if (!valid.length) return;
    const nodes: Node[] = [];
    for (const p of valid) nodes.push(makeChip(p, basename(p)), document.createTextNode(" "));
    promptRef.current?.insertNodes(nodes);
  };

  // File selection → attach.
  const attach = async () => {
    if (!onAttachFile) return;
    const p = await onAttachFile();
    if (p) addAttachments([p]);
  };

  // Drag-drop → convert Files to absolute paths and insert chips at the drop point (when possible).
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (disabled || !onDropFiles) return;
    const ed = promptRef.current?.getElement();
    const r = (document as { caretRangeFromPoint?: (x: number, y: number) => Range | null }).caretRangeFromPoint?.(e.clientX, e.clientY);
    if (ed && r && ed.contains(r.commonAncestorContainer)) {
      const s = window.getSelection();
      s?.removeAllRanges();
      s?.addRange(r);
    }
    const files = Array.from(e.dataTransfer.files);
    if (files.length) addAttachments(onDropFiles(files));
  };

  return (
    <div
      className={cn(
        "relative flex flex-col gap-2 rounded-xl border bg-ink/40 px-3 py-2 focus-within:border-accent/50",
        dragOver ? "border-accent/70 bg-accent/5" : "border-line",
        className,
      )}
      onDragOver={(e) => { if (onDropFiles && !disabled) { e.preventDefault(); setDragOver(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false); }}
      onDrop={onDrop}
    >
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-accent/60 bg-ink/70 text-[12px] font-medium text-accent">
          {t("composer.dropToAttach")}
        </div>
      )}
      <PromptEditor
        ref={promptRef}
        initialText={initialText}
        onChange={setText}
        commands={commands}
        browseDir={browseDir}
        placeholder={placeholderText}
        disabled={disabled}
        autoFocus={autoFocus}
        onSubmit={submit}
        onEscape={onEscape}
        onCommandAction={(action) => onCommandAction?.(action)}
      />
      {/* flex-wrap so the controls reflow onto a second line in a very narrow pane instead of overflowing (the outer <main>
          now clips, so without wrap the send button could be cut off). */}
      <div className="flex flex-wrap items-center gap-1.5">
        {leftSlot}
        {controls &&
          (controls.editable ? (
            <>
              {codexFreeText ? (
                <Input
                  size="xs"
                  className="min-w-0 text-fg-dim"
                  title={t("composer.modelTitle")}
                  value={controls.model}
                  disabled={disabled}
                  onChange={(e) => controls.onModel?.(e.target.value)}
                />
              ) : (
                <Select
                  size="xs"
                  className="min-w-0 text-fg-dim"
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
              {controls.effort !== undefined && effortSupported(controls.model) && (
                <Select
                  size="xs"
                  className="min-w-0 text-fg-dim"
                  title={t("composer.effortTitle")}
                  value={controls.effort}
                  disabled={disabled}
                  onChange={(e) => controls.onEffort?.(e.target.value)}
                >
                  {effortOptions.map((ef) => (
                    <option key={ef} value={ef}>{t(effortLabelKey(ef))}</option>
                  ))}
                </Select>
              )}
              {controls.permissionMode !== undefined && (
                <Select
                  size="xs"
                  className="min-w-0 text-fg-dim"
                  title={t("composer.permTitle")}
                  value={controls.permissionMode}
                  disabled={disabled}
                  onChange={(e) => controls.onPermissionMode?.(e.target.value)}
                >
                  {(controls.permissionModes ?? PERMISSION_MODES).map((pm) => (
                    <option key={pm} value={pm}>{permLabel(pm, t)}</option>
                  ))}
                </Select>
              )}
            </>
          ) : (
            <span className="font-mono text-[11px] text-muted" title={t("composer.fixedModelTitle")}>
              ◇ {modelList.find((m) => m.id === controls.model)?.label ?? controls.model}
              {controls.effort !== undefined && effortSupported(controls.model) ? ` · ${t(effortLabelKey(controls.effort))}` : ""}
            </span>
          ))}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {onSideSend && !disabled && (
            <Button variant="ghost" size="icon" aria-label={t("composer.sideQuestion")} disabled={!text.trim()} onClick={submitSide}>
              <MessageCircleQuestion size={16} />
            </Button>
          )}
          {onAttachFile && (
            <Button variant="ghost" size="icon" aria-label={t("composer.attachFile")} disabled={disabled} onClick={() => void attach()}>
              <Paperclip size={15} />
            </Button>
          )}
          {/* Stop stays visible for the whole turn so an in-progress turn can always be aborted (audit #23). Once you type/attach
              something, Send appears alongside Stop (Stop first) so you can either abort the turn or queue the next message. When
              disabled (e.g. Slack readonly), the stop button is hidden. */}
          {busy && onStop && !disabled && (
            <Button variant="danger" size="icon" disabled={stopping} aria-label={t("composer.stop")} onClick={() => { setStopping(true); onStop(); }}>
              {stopping ? <Loader2 size={14} className="animate-spin" /> : <Square size={14} />}
            </Button>
          )}
          {!(busy && onStop && !disabled && !text.trim()) && (
            <Button variant="primary" size="icon" aria-label={sendLabelText} disabled={disabled || (!text.trim() && !allowEmpty)} onClick={submit}>
              <Send size={16} />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
