import { ListItemNode, ListNode } from "@lexical/list";
import { createEmptyHistoryState } from "@lexical/history";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  CLEAR_HISTORY_COMMAND,
  COMMAND_PRIORITY_HIGH,
  HISTORY_PUSH_TAG,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
  type EditorState,
  type LexicalEditor,
  type NodeKey,
} from "lexical";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CommandAction, CommandCandidate } from "@daemon/core/capabilities/commands.js";
import type { BrowseResult } from "../types/rookery.js";
import { cn } from "../lib/cn.js";
import { useT } from "../i18n/provider.js";
import { FileMentionPopup } from "./FileMentionPopup.js";
import {
  $createFileMentionNode,
  $isFileMentionNode,
  FileMentionNode,
} from "../editor/FileMentionNode.js";
import {
  $serializePrompt,
  $setPromptText,
  PROMPT_TRANSFORMERS,
} from "../editor/prompt-serialization.js";
import {
  EditablePlugin,
  FocusPlugin,
  HistoryBaselinePlugin,
  PlainTextPastePlugin,
} from "../editor/PromptEditorPlugins.js";
import { useLexicalFileMention } from "../editor/use-lexical-file-mention.js";

export type SlashCommand = CommandCandidate;

export interface PromptFile {
  path: string;
  name: string;
}

const MAX_MATCHES = 50;

// Only a slash query when the last token at the caret starts with "/". Something like "a/b" doesn't trigger it.
export function slashQueryOf(text: string): string | null {
  const token = text.split(/\s/).pop() ?? "";
  if (!token.startsWith("/")) return null;
  return token.slice(1).toLowerCase();
}

export function matchCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const hit = (command: SlashCommand) => command.name.toLowerCase().includes(query)
    || (command.aliases ?? []).some((alias) => alias.toLowerCase().includes(query));
  const starts = (command: SlashCommand) => command.name.toLowerCase().startsWith(query);
  return commands
    .filter(hit)
    .sort((a, b) => Number(starts(b)) - Number(starts(a)))
    .slice(0, MAX_MATCHES);
}

export interface PromptEditorHandle {
  insertFiles(files: PromptFile[]): void;
  insertText(text: string): void;
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

interface TextToken {
  nodeKey: NodeKey;
  start: number;
  end: number;
}

function $selectTextToken(token: TextToken): boolean {
  const node = $getNodeByKey(token.nodeKey);
  if (!$isTextNode(node) || $isFileMentionNode(node)) return false;
  if (token.end > node.getTextContentSize()) return false;
  const selection = $createRangeSelection();
  selection.anchor.set(token.nodeKey, token.start, "text");
  selection.focus.set(token.nodeKey, token.end, "text");
  $setSelection(selection);
  return true;
}

function $rangeSelectionAtCaretOrEnd() {
  let selection = $getSelection();
  if (!$isRangeSelection(selection)) {
    $getRoot().selectEnd();
    selection = $getSelection();
  }
  return $isRangeSelection(selection) ? selection : null;
}

const PromptEditorInner = forwardRef<PromptEditorHandle, PromptEditorProps>(function PromptEditorInner(props, ref) {
  const t = useT();
  const {
    autoFocus = false,
    browseDir,
    commands = [],
    disabled = false,
    onChange,
    onCommandAction,
    onEscape,
    onSubmit,
  } = props;
  const [editor] = useLexicalComposerContext();
  const historyState = useMemo(() => createEmptyHistoryState(), []);
  const lastTextRef = useRef(props.initialText ?? "");
  const [isEmpty, setIsEmpty] = useState((props.initialText ?? "") === "");
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [slashSel, setSlashSel] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const slashTokenRef = useRef<TextToken | null>(null);
  const fileMention = useLexicalFileMention({ editor, browseDir, disabled });

  const executableCommands = onCommandAction
    ? commands
    : commands.filter((command) => command.action.type === "insert-prompt");
  const slashMatches = useMemo(
    () => slashQuery == null ? [] : matchCommands(executableCommands, slashQuery),
    [executableCommands, slashQuery],
  );
  const slashOpen = slashQuery != null
    && slashMatches.length > 0
    && !slashDismissed
    && !disabled;

  useEffect(() => editor.registerUpdateListener(({
    dirtyElements,
    dirtyLeaves,
    editorState,
  }) => {
    editorState.read(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection) || !selection.isCollapsed() || selection.anchor.type !== "text") {
        slashTokenRef.current = null;
        setSlashQuery(null);
        return;
      }
      const node = selection.anchor.getNode();
      if (!$isTextNode(node) || $isFileMentionNode(node)) {
        slashTokenRef.current = null;
        setSlashQuery(null);
        return;
      }
      const end = selection.anchor.offset;
      const query = slashQueryOf(node.getTextContent().slice(0, end));
      if (query == null) {
        slashTokenRef.current = null;
        setSlashQuery(null);
        return;
      }
      slashTokenRef.current = {
        nodeKey: node.getKey(),
        start: end - query.length - 1,
        end,
      };
      setSlashQuery(query);
      setSlashSel(0);
      if (dirtyElements.size > 0 || dirtyLeaves.size > 0) setSlashDismissed(false);
    });
  }), [editor]);

  const pickCommand = useCallback((command: SlashCommand) => {
    const token = slashTokenRef.current;
    if (token == null) return;
    const replacement = command.action.type === "insert-prompt"
      ? `${command.action.text} `
      : command.argumentHint
        ? `/${command.name} `
        : "";
    editor.update(() => {
      if (!$selectTextToken(token)) return;
      const selection = $getSelection();
      if ($isRangeSelection(selection)) selection.insertText(replacement);
    }, { discrete: true, tag: HISTORY_PUSH_TAG });
    setSlashDismissed(true);
    if (command.action.type !== "insert-prompt" && !command.argumentHint) {
      onCommandAction?.(command.action);
    }
    requestAnimationFrame(() => editor.focus());
  }, [editor, onCommandAction]);

  useEffect(() => {
    const unregister = [
      editor.registerCommand(KEY_ARROW_DOWN_COMMAND, (event) => {
        if (fileMention.open) {
          event.preventDefault();
          fileMention.setSel((fileMention.sel + 1) % fileMention.entries.length);
          return true;
        }
        if (slashOpen) {
          event.preventDefault();
          setSlashSel((current) => (current + 1) % slashMatches.length);
          return true;
        }
        return false;
      }, COMMAND_PRIORITY_HIGH),
      editor.registerCommand(KEY_ARROW_UP_COMMAND, (event) => {
        if (fileMention.open) {
          event.preventDefault();
          fileMention.setSel((fileMention.sel - 1 + fileMention.entries.length) % fileMention.entries.length);
          return true;
        }
        if (slashOpen) {
          event.preventDefault();
          setSlashSel((current) => (current - 1 + slashMatches.length) % slashMatches.length);
          return true;
        }
        return false;
      }, COMMAND_PRIORITY_HIGH),
      editor.registerCommand(KEY_TAB_COMMAND, (event) => {
        if (fileMention.open) {
          event.preventDefault();
          fileMention.pick(fileMention.entries[fileMention.sel] ?? fileMention.entries[0]!);
          return true;
        }
        if (slashOpen) {
          event.preventDefault();
          pickCommand(slashMatches[slashSel] ?? slashMatches[0]!);
          return true;
        }
        return false;
      }, COMMAND_PRIORITY_HIGH),
      editor.registerCommand(KEY_ENTER_COMMAND, (event) => {
        if (event == null) return false;
        if (event.isComposing || editor.isComposing()) return false;
        if (!event.shiftKey && fileMention.open) {
          event.preventDefault();
          fileMention.pick(fileMention.entries[fileMention.sel] ?? fileMention.entries[0]!);
          return true;
        }
        if (!event.shiftKey && slashOpen) {
          event.preventDefault();
          pickCommand(slashMatches[slashSel] ?? slashMatches[0]!);
          return true;
        }
        if (event.shiftKey || onSubmit == null) return false;
        event.preventDefault();
        onSubmit();
        return true;
      }, COMMAND_PRIORITY_HIGH),
      editor.registerCommand(KEY_ESCAPE_COMMAND, (event) => {
        if (fileMention.open) {
          event.preventDefault();
          fileMention.dismiss();
          return true;
        }
        if (slashOpen) {
          event.preventDefault();
          setSlashDismissed(true);
          return true;
        }
        if (onEscape != null) {
          event.preventDefault();
          onEscape();
          return true;
        }
        return false;
      }, COMMAND_PRIORITY_HIGH),
    ];
    return () => unregister.forEach((dispose) => dispose());
  }, [editor, fileMention, onEscape, onSubmit, pickCommand, slashMatches, slashOpen, slashSel]);

  useImperativeHandle(ref, () => ({
    insertFiles: (files) => {
      if (files.length === 0) return;
      editor.update(() => {
        const selection = $rangeSelectionAtCaretOrEnd();
        if (selection == null) return;
        selection.insertNodes(files.flatMap(({ path, name }) => [
          $createFileMentionNode(path, name),
          $createTextNode(" "),
        ]));
      }, { discrete: true, tag: HISTORY_PUSH_TAG });
      requestAnimationFrame(() => editor.focus());
    },
    insertText: (text) => {
      editor.update(() => {
        $rangeSelectionAtCaretOrEnd()?.insertRawText(text);
      }, { discrete: true, tag: HISTORY_PUSH_TAG });
    },
    clear: () => {
      editor.update(() => {
        $getRoot().clear().append($createParagraphNode());
        $getRoot().selectEnd();
      }, { discrete: true, tag: HISTORY_PUSH_TAG });
      editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined);
      // CLEAR_HISTORY_COMMAND deliberately nulls current. The cleared prompt
      // is the new baseline: it must not undo into a sent message, while the
      // first fresh edit still needs to be undoable.
      historyState.current = { editor, editorState: editor.getEditorState() };
      setSlashDismissed(false);
    },
    focus: () => editor.focus(),
    getText: () => editor.getEditorState().read($serializePrompt),
    getElement: () => editor.getRootElement() as HTMLDivElement | null,
  }), [editor, historyState]);

  const handleChange = useCallback((editorState: EditorState) => {
    const nextText = editorState.read($serializePrompt);
    setIsEmpty(nextText === "");
    if (nextText === lastTextRef.current) return;
    lastTextRef.current = nextText;
    onChange?.(nextText);
  }, [onChange]);

  const editorClassName = cn(
    "max-h-48 min-h-[40px] w-full overflow-y-auto whitespace-pre-wrap break-words text-[13px] leading-relaxed text-fg outline-none [overflow-wrap:anywhere]",
    disabled && "opacity-50",
    props.className,
  );

  return (
    <div className="relative">
      {slashOpen && (
        <div className="pop-in absolute bottom-full left-0 z-30 mb-2 max-h-64 w-[min(420px,100%)] origin-bottom-left overflow-y-auto rounded-lg border border-line bg-raised p-1 shadow-xl">
          {slashMatches.map((command, index) => (
            <button
              key={command.name}
              type="button"
              className={`flex w-full flex-col items-start gap-0.5 rounded-md px-2.5 py-1.5 text-left ${index === slashSel ? "bg-accent/15" : "hover:bg-line/40"}`}
              onMouseEnter={() => setSlashSel(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pickCommand(command)}
            >
              <span className="font-mono text-[12px] text-fg">
                /{command.name}{command.argumentHint ? <span className="ml-1 text-muted">{command.argumentHint}</span> : null}
              </span>
              {command.description && <span className="line-clamp-1 text-[11px] text-muted">{command.description}</span>}
            </button>
          ))}
        </div>
      )}
      {fileMention.open && (
        <FileMentionPopup
          entries={fileMention.entries}
          sel={fileMention.sel}
          onHover={fileMention.setSel}
          onPick={fileMention.pick}
        />
      )}
      {isEmpty && props.placeholder ? (
        <div className="pointer-events-none absolute left-0 top-0 select-none text-[13px] leading-relaxed text-muted">
          {props.placeholder}
        </div>
      ) : null}
      <RichTextPlugin
        contentEditable={(
          <ContentEditable
            role="textbox"
            aria-label={props.ariaLabel ?? t("composer.editorAriaLabel")}
            aria-multiline="true"
            style={props.minHeight ? { minHeight: props.minHeight } : undefined}
            className={editorClassName}
          />
        )}
        placeholder={null}
        ErrorBoundary={LexicalErrorBoundary}
      />
      <HistoryPlugin externalHistoryState={historyState} />
      <HistoryBaselinePlugin historyState={historyState} />
      <ListPlugin />
      <MarkdownShortcutPlugin transformers={PROMPT_TRANSFORMERS} />
      <PlainTextPastePlugin />
      <EditablePlugin editable={!disabled} />
      <FocusPlugin autoFocus={autoFocus} />
      <OnChangePlugin
        ignoreSelectionChange
        ignoreHistoryMergeTagChange={false}
        onChange={handleChange}
      />
    </div>
  );
});

export const PromptEditor = forwardRef<PromptEditorHandle, PromptEditorProps>(function PromptEditor(props, ref) {
  const [initialConfig] = useState(() => ({
    namespace: "RookeryPromptEditor",
    nodes: [FileMentionNode, ListNode, ListItemNode],
    editable: !props.disabled,
    editorState: () => {
      $setPromptText(props.initialText ?? "");
      $getRoot().selectEnd();
    },
    theme: {
      list: { ul: "prompt-list" },
      text: { bold: "font-semibold", code: "md-code" },
    },
    onError: (error: Error) => { throw error; },
  }));

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <PromptEditorInner {...props} ref={ref} />
    </LexicalComposer>
  );
});
