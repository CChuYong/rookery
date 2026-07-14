import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { ClipboardEvent, KeyboardEvent } from "react";
import type { CommandAction, CommandCandidate } from "@daemon/core/capabilities/commands.js";
import { serializeEditor, setEditorText, insertNodesAtCaret, applyMarkdownShortcuts } from "../lib/mention-editor.js";
import { useFileMention } from "../lib/use-file-mention.js";
import type { BrowseResult } from "../types/rookery.js";
import { FileMentionPopup } from "./FileMentionPopup.js";
import { cn } from "../lib/cn.js";
import { useT } from "../i18n/provider.js";

export type SlashCommand = CommandCandidate;

const MAX_MATCHES = 50;
// Only a slash query when the last token at the caret starts with "/". Something like "a/b" doesn't trigger it.
export function slashQueryOf(text: string): string | null {
  const token = text.split(/\s/).pop() ?? "";
  if (!token.startsWith("/")) return null;
  return token.slice(1).toLowerCase();
}
export function matchCommands(commands: SlashCommand[], q: string): SlashCommand[] {
  const hit = (c: SlashCommand) => c.name.toLowerCase().includes(q) || (c.aliases ?? []).some((a) => a.toLowerCase().includes(q));
  const starts = (c: SlashCommand) => c.name.toLowerCase().startsWith(q);
  return commands.filter(hit).sort((a, b) => Number(starts(b)) - Number(starts(a))).slice(0, MAX_MATCHES);
}

export interface PromptEditorHandle {
  insertNodes(nodes: Node[]): void;
  insertText(s: string): void;
  clear(): void;
  focus(): void;
  getText(): string;
  getElement(): HTMLDivElement | null;
}
export interface PromptEditorProps {
  initialText?: string;
  onChange?: (text: string) => void;
  commands?: SlashCommand[];
  browseDir?: (dir: string) => Promise<BrowseResult>;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  minHeight?: number;
  className?: string;
  ariaLabel?: string;
  onSubmit?: () => void;
  onEscape?: () => void;
  onCommandAction?: (action: CommandAction) => void;
}

export const PromptEditor = forwardRef<PromptEditorHandle, PromptEditorProps>(function PromptEditor(p, ref) {
  const t = useT();
  const { commands = [], browseDir, disabled = false, onChange, onSubmit, onEscape, onCommandAction } = p;
  const [text, setText] = useState(p.initialText ?? "");
  const [sel, setSel] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const edRef = useRef<HTMLDivElement>(null);
  const pendingCompositionNewline = useRef(false);

  useEffect(() => { if (p.autoFocus) edRef.current?.focus(); }, [p.autoFocus]);
  useEffect(() => {
    if (p.initialText && edRef.current) setEditorText(edRef.current, p.initialText);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const slashQuery = slashQueryOf(text);
  const executableCommands = onCommandAction ? commands : commands.filter((command) => command.action.type === "insert-prompt");
  const matches = slashQuery !== null ? matchCommands(executableCommands, slashQuery) : [];
  const popupOpen = slashQuery !== null && matches.length > 0 && !dismissed && !disabled;

  const syncText = () => {
    if (!edRef.current) return;
    const s = serializeEditor(edRef.current);
    setText(s);
    onChange?.(s);
  };

  const fm = useFileMention({ edRef, browseDir, disabled, afterEdit: syncText });

  const pickCommand = (c: SlashCommand) => {
    const ed = edRef.current; if (!ed) return;
    const replacement = c.action.type === "insert-prompt"
      ? `${c.action.text} `
      : c.argumentHint
        ? `/${c.name} `
        : "";
    const replaced = text.replace(/(^|\s)\/\S*$/, (_m, pre: string) => `${pre}${replacement}`);
    setEditorText(ed, replaced);
    setText(replaced); onChange?.(replaced);
    setDismissed(true);
    if (c.action.type !== "insert-prompt" && !c.argumentHint) onCommandAction?.(c.action);
    requestAnimationFrame(() => ed.focus());
  };
  const newline = () => {
    if (!edRef.current) return;
    insertNodesAtCaret(edRef.current, [document.createTextNode("\n")]);
    syncText();
  };

  useImperativeHandle(ref, () => ({
    insertNodes: (nodes) => { const ed = edRef.current; if (!ed) return; insertNodesAtCaret(ed, nodes); syncText(); requestAnimationFrame(() => ed.focus()); },
    insertText: (s) => { const ed = edRef.current; if (!ed) return; insertNodesAtCaret(ed, [document.createTextNode(s)]); syncText(); },
    clear: () => { const ed = edRef.current; if (!ed) return; ed.innerHTML = ""; setText(""); onChange?.(""); setDismissed(false); },
    focus: () => edRef.current?.focus(),
    getText: () => (edRef.current ? serializeEditor(edRef.current) : ""),
    getElement: () => edRef.current,
  }), [onChange]);

  const onPaste = (e: ClipboardEvent) => {
    e.preventDefault();
    const txt = e.clipboardData.getData("text/plain");
    if (txt && edRef.current) { insertNodesAtCaret(edRef.current, [document.createTextNode(txt)]); syncText(); }
  };

  const onCompositionEnd = () => {
    if (!pendingCompositionNewline.current) return;
    pendingCompositionNewline.current = false;
    window.setTimeout(newline, 0);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && e.shiftKey && e.nativeEvent.isComposing) {
      pendingCompositionNewline.current = true;
      return;
    }
    if (popupOpen) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => (s + 1) % matches.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => (s - 1 + matches.length) % matches.length); return; }
      if ((e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) || e.key === "Tab") { e.preventDefault(); pickCommand(matches[sel] ?? matches[0]!); return; }
      if (e.key === "Escape") { e.preventDefault(); setDismissed(true); return; }
    }
    if (fm.onKeyDown(e)) return;
    if (e.key === "Escape") { onEscape?.(); return; }
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (e.shiftKey || !onSubmit) { newline(); return; }
      onSubmit();
    }
  };

  return (
    <div className="relative">
      {popupOpen && (
        <div className="pop-in absolute bottom-full left-0 z-30 mb-2 max-h-64 w-[min(420px,100%)] origin-bottom-left overflow-y-auto rounded-lg border border-line bg-raised p-1 shadow-xl">
          {matches.map((c, i) => (
            <button
              key={c.name}
              type="button"
              className={`flex w-full flex-col items-start gap-0.5 rounded-md px-2.5 py-1.5 text-left ${i === sel ? "bg-accent/15" : "hover:bg-line/40"}`}
              onMouseEnter={() => setSel(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pickCommand(c)}
            >
              <span className="font-mono text-[12px] text-fg">
                /{c.name}{c.argumentHint ? <span className="ml-1 text-muted">{c.argumentHint}</span> : null}
              </span>
              {c.description && <span className="line-clamp-1 text-[11px] text-muted">{c.description}</span>}
            </button>
          ))}
        </div>
      )}
      {fm.open && <FileMentionPopup entries={fm.entries} sel={fm.sel} onHover={fm.setSel} onPick={fm.pick} />}
      {text === "" && p.placeholder && (
        <div className="pointer-events-none absolute left-0 top-0 select-none text-[13px] leading-relaxed text-muted">{p.placeholder}</div>
      )}
      <div
        ref={edRef}
        role="textbox"
        aria-label={p.ariaLabel ?? t("composer.editorAriaLabel")}
        aria-multiline="true"
        contentEditable={!disabled}
        suppressContentEditableWarning
        style={p.minHeight ? { minHeight: p.minHeight } : undefined}
        className={cn(
          "max-h-48 min-h-[40px] w-full overflow-y-auto whitespace-pre-wrap break-words text-[13px] leading-relaxed text-fg outline-none [overflow-wrap:anywhere]",
          disabled && "opacity-50",
          p.className,
        )}
        onInput={(e) => {
          if (edRef.current && !(e.nativeEvent as InputEvent).isComposing) applyMarkdownShortcuts(edRef.current);
          syncText(); setSel(0); setDismissed(false); fm.refresh();
        }}
        onPaste={onPaste}
        onCompositionEnd={onCompositionEnd}
        onKeyDown={onKeyDown}
      />
    </div>
  );
});
