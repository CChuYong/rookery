import type { ImageRef } from "@daemon/core/image-input.js";
import { MessageImages } from "./MessageImages.js";
import { memo, useEffect, useRef, useState, cloneElement, type ReactElement } from "react";
import { MessageSquareDashed, ArrowDown } from "lucide-react";
import type { LogItem } from "../store/reduce.js";
import { ToolGroup } from "./ToolGroup.js";
import { InteractionCard } from "./InteractionCard.js";
import type { InteractionAnswer } from "./InteractionCard.js";
import { AssistantMessage } from "./AssistantMessage.js";
import { UserMarkdown } from "./Markdown.js";
import { ThinkingBlock } from "./ThinkingBlock.js";
import { cn } from "../lib/cn.js";
import { railClass, statusTag, statusLabelKey, isLive } from "../lib/status.js";
import { scrollToBottom } from "../lib/scroll.js";
import { useT } from "../i18n/provider.js";
import { SkeletonRows } from "./Skeleton.js";

type ToolItem = Extract<LogItem, { kind: "tool" }>;

function MessageListImpl({
  items,
  kind = "master",
  loaded,
  loadFailed,
  onRetryHistory,
  onRetryInput,
  onRestoreInput,
  onRecoverInput,
  onOpenFile,
  onSelectWorker,
  onRespond,
}: {
  items: LogItem[];
  kind?: "master" | "worker"; // which empty hint to show once loaded-and-empty (audit #43 — the worker copy must not say "master")
  loaded?: boolean; // the session.history/worker.history fetch for this id has succeeded at least once (default true — keeps direct/test callers on the old immediate-empty behavior)
  loadFailed?: boolean; // that fetch was rejected and hasn't succeeded since → error+retry instead of a permanently blank pane
  onRetryHistory?: () => void; // re-fires the history fetch that failed
  onRestoreInput?: (text:string,images?:ImageRef[]) => void;
  onRecoverInput?: () => void;
  onRetryInput?: (text: string, images?: ImageRef[]) => void | Promise<void>;
  onOpenFile?: (path: string) => void;
  onSelectWorker?: (id: string) => void;
  onRespond?: (requestId: string, res: InteractionAnswer) => void;
}): JSX.Element {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true); // auto-follow new content when the user is near the bottom
  const [atBottom, setAtBottom] = useState(true); // for showing the pin button (only when scrolled up)
  const toBottom = () => {
    const el = ref.current;
    if (!el) return;
    scrollToBottom(el); // discrete action (pin click) → reduced-motion-aware smooth
    stick.current = true;
    setAtBottom(true);
  };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const last = items[items.length - 1];
    const userJustSent = last?.kind === "message" && last.role === "user";
    // follow a just-sent message smoothly (discrete), but keep streaming token-follow instant (smooth would lag the caret).
    if (userJustSent) scrollToBottom(el);
    else if (stick.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  if (items.length === 0) {
    // No committed transcript yet — three distinct states (audit #43): still fetching, fetch failed, or genuinely
    // empty. Mirrors the loaded/loadFailed idiom already used by RepoTree/Sessions/AutomationPage: once loaded is
    // true, a later background-refresh failure (e.g. on reconnect) doesn't hide what's already showing.
    if (!(loaded ?? true)) {
      if (loadFailed) {
        return (
          <div className="flex flex-1 flex-col items-center justify-center gap-2.5 px-6 text-center">
            <button onClick={onRetryHistory} className="flex flex-col items-center gap-2.5 text-fail transition-colors hover:underline">
              <MessageSquareDashed size={28} className="opacity-40" />
              <span className="text-body">{t("messageList.loadFailed")}</span>
            </button>
          </div>
        );
      }
      return (
        <div className="flex flex-1 flex-col justify-center px-6">
          <SkeletonRows rows={5} />
        </div>
      );
    }
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2.5 px-6 text-center text-muted">
        <MessageSquareDashed size={28} className="opacity-40" />
        <p className="text-body">{t(kind === "worker" ? "messageList.emptyHintWorker" : "messageList.emptyHintMaster")}</p>
      </div>
    );
  }

  // group consecutive tool items into a single ToolGroup (so a flood of tools doesn't bury the conversation).
  const rows: JSX.Element[] = [];
  for (let i = 0; i < items.length; ) {
    const it = items[i]!;
    if (it.kind === "tool") {
      const start = i;
      const group: ToolItem[] = [];
      while (i < items.length && items[i]!.kind === "tool") {
        group.push(items[i] as ToolItem);
        i++;
      }
      rows.push(<ToolGroup key={`t${start}`} tools={group} onOpenFile={onOpenFile} onSelectWorker={onSelectWorker} />);
      continue;
    }
    if (it.kind === "message") {
      if (it.role === "user") {
        // user message: a quiet raised bubble, right-aligned, narrower than the full column (T3's chat bubble).
        rows.push(
          <div
            key={i}
            className="max-w-[80%] self-end [overflow-wrap:anywhere] rounded-md bg-raised px-3 py-2 text-prose leading-[1.6] text-fg"
          >
            {/* markdown on the bubble (remarkBreaks keeps casual newlines; rehypeMentions keeps @file chips) */}
            <MessageImages images={it.images} />
            {it.content && <UserMarkdown content={it.content} />}
          </div>,
        );
      } else {
        // agent message: full width without a bubble (flowing like a document). copy button below on hover.
        rows.push(<AssistantMessage key={i} content={it.content} streaming={it.streaming} ts={it.ts} />);
      }
    } else if (it.kind === "failedInput") {
      rows.push(<FailedInput key={i} item={it} onRetry={onRetryInput} onRestore={onRestoreInput} onRecover={onRecoverInput} />);
    } else if (it.kind === "thinking") {
      rows.push(<ThinkingBlock key={i} text={it.text} streaming={it.streaming} />);
    } else if (it.kind === "notice") {
      // informational system push (compaction/retry/fallback) — centered, subtle chip.
      // translate coded notices to the active locale; fall back to the pre-rendered text.
      rows.push(
        <div key={i} className="my-0.5 self-center rounded px-2 py-0.5 text-meta text-muted">
          {it.code ? t(it.code, it.params) : it.text}
        </div>,
      );
    } else if (it.kind === "worker") {
      // marker for a worker spawned by the master. if onSelectWorker is present (master conversation), click to jump to that worker view (repo tab).
      const wid = it.workerId;
      const dotCls = cn("h-1.5 w-1.5 shrink-0 rounded-full", isLive(it.status) ? "bg-run led-live" : railClass(it.status));
      const tail = `→ ${statusTag(it.status).toLowerCase()}`;
      rows.push(
        onSelectWorker ? (
          <button
            key={i}
            onClick={() => onSelectWorker(wid)}
            title={t("messageList.jumpToWorker")}
            className="group flex h-6 items-center gap-1.5 self-start rounded px-1 font-mono text-meta text-muted transition-colors hover:bg-raised/50 hover:text-fg-dim"
          >
            <span className={dotCls} />
            <span className="text-fg-dim group-hover:underline">{wid}</span>
            <span title={t(statusLabelKey(it.status))}>{tail}</span>
          </button>
        ) : (
          <div key={i} className="flex h-6 items-center gap-1.5 self-start font-mono text-meta text-muted">
            <span className={dotCls} />
            <span className="text-fg-dim">{wid}</span>
            <span title={t(statusLabelKey(it.status))}>{tail}</span>
          </div>
        ),
      );
    } else if (it.kind === "interaction") {
      rows.push(<InteractionCard key={i} item={it} onRespond={onRespond} />);
    }
    // metrics (kind==="metrics"): don't render an inline bubble — the session header (SessionMetrics) shows the same stats.
    // (the metrics log item itself is kept as-is, since the header reads it from logsBySession.)
    i++;
  }

  // rise-in only on the latest (last) row. with index keys, a new row mounts as a new DOM node → appears once (CSS runs only on mount).
  // while streaming, the same last row keeps its class so it doesn't re-run; when a new row is appended, only that new row animates in.
  // even on a large reconnect seed, only the single last row mounts/animates → no flash-storm.
  if (rows.length > 0) {
    const li = rows.length - 1;
    const el = rows[li] as ReactElement<{ className?: string }>;
    rows[li] = cloneElement(el, { className: cn(el.props.className, "rise-in") });
  }

  // typing indicator right after sending (last item is my message) until the assistant responds.
  const last = items[items.length - 1];
  const waiting = last?.kind === "message" && last.role === "user";

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={ref}
        // role=log + aria-live: announce streamed/appended transcript content to screen readers (the led-pulse "alive" signal
        // has no non-visual equivalent otherwise). additions+text so token deltas are read; not atomic so it doesn't re-read the whole log.
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        aria-atomic="false"
        onScroll={(e) => {
          const el = e.currentTarget;
          const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
          stick.current = bottom;
          setAtBottom(bottom);
        }}
        // The scroller spans the whole pane so its scrollbar sits at the pane edge and the wheel works over the side
        // margins too (audit #14); the centered 720px reading column (T3 Code) lives inside it.
        className="min-h-0 w-full flex-1 overflow-y-auto"
      >
        {/* [&>*]:shrink-0 — prevents the flexbox bug where direct children get vertically squished when the window shrinks. */}
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-2.5 px-6 py-5 [&>*]:shrink-0">
          {rows}
          {waiting && (
            <div role="status" className="rise-in flex h-6 items-center gap-1.5 self-start px-1">
              <span className="h-1.5 w-1.5 rounded-full bg-accent text-accent led-live" />
              <span className="text-ui text-muted">{t("messageList.thinking")}</span>
            </div>
          )}
        </div>
      </div>
      {!atBottom && (
        <button
          onClick={toBottom}
          aria-label={t("messageList.scrollToBottom")}
          // fade-in only (opacity) — avoids conflicting with the centering -translate-x-1/2 transform.
          className="fade-in absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-line bg-raised px-2.5 py-1 text-meta text-fg-dim shadow-md transition-colors hover:text-fg"
        >
          <ArrowDown size={12} /> {t("messageList.scrollToBottom")}
        </button>
      )}
    </div>
  );
}

export const MessageList = memo(MessageListImpl);
MessageList.displayName = "MessageList";

function FailedInput({
  item,
  onRetry,
  onRestore,
  onRecover,
}: {
  onRestore?: (text: string, images?: ImageRef[]) => void;
  onRecover?: () => void;
  item: Extract<LogItem, { kind: "failedInput" }>;
  onRetry?: (text: string, images?: ImageRef[]) => void | Promise<void>;
}): JSX.Element {
  const t = useT();
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  return (
    <div className="max-w-[80%] self-end rounded-md border border-line bg-raised px-3 py-2 text-ui">
      <MessageImages images={item.images} />
      {item.text && <UserMarkdown content={item.text} />}
      <div className="text-meta text-fail">{t("images.sendFailed")}</div>
      {onRestore && (
        <div className="flex gap-3">
          <button
            type="button"
            className="text-meta text-fg-dim hover:underline"
            onClick={() => onRestore(item.text, item.images)}
          >
            {t("images.restoreDraft")}
          </button>
          {onRecover && (
            <button
              type="button"
              className="text-meta text-fg-dim hover:underline"
              onClick={onRecover}
            >
              {t("images.recoverWorker")}
            </button>
          )}
        </div>
      )}
      {onRetry && (
        <button
          type="button"
          className="mt-1 text-meta text-fg-dim hover:underline disabled:text-faint"
          disabled={sending || sent}
          onClick={() => {
            setSending(true);
            Promise.resolve()
              .then(() => onRetry(item.text, item.images))
              .then(() => setSent(true))
              .catch(() => {})
              .finally(() => setSending(false));
          }}
        >
          {t(sent ? "images.retried" : "images.retrySend")}
        </button>
      )}
    </div>
  );
}
