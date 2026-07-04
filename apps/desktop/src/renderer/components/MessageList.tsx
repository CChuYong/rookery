import { memo, useEffect, useRef, useState, cloneElement, type ReactElement } from "react";
import { MessageSquareDashed, ArrowDown } from "lucide-react";
import type { LogItem } from "../store/reduce.js";
import { ToolGroup } from "./ToolGroup.js";
import { InteractionCard } from "./InteractionCard.js";
import type { InteractionAnswer } from "./InteractionCard.js";
import { AssistantMessage } from "./AssistantMessage.js";
import { MentionText } from "./MentionText.js";
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
  onOpenFile,
  onSelectWorker,
  onRespond,
}: {
  items: LogItem[];
  kind?: "master" | "worker"; // which empty hint to show once loaded-and-empty (audit #43 — the worker copy must not say "master")
  loaded?: boolean; // the session.history/worker.history fetch for this id has succeeded at least once (default true — keeps direct/test callers on the old immediate-empty behavior)
  loadFailed?: boolean; // that fetch was rejected and hasn't succeeded since → error+retry instead of a permanently blank pane
  onRetryHistory?: () => void; // re-fires the history fetch that failed
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
              <span className="text-[13px]">{t("messageList.loadFailed")}</span>
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
        <p className="text-[13px]">{t(kind === "worker" ? "messageList.emptyHintWorker" : "messageList.emptyHintMaster")}</p>
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
        // user message: keep the right-aligned bubble.
        rows.push(
          <div
            key={i}
            className="max-w-[80%] self-end whitespace-pre-wrap [overflow-wrap:anywhere] rounded-2xl rounded-br-md bg-accent px-3.5 py-2.5 text-[13.5px] leading-relaxed text-accent-ink shadow-[0_1px_10px_-3px_color-mix(in_srgb,var(--color-accent)_40%,transparent)]"
          >
            <MentionText text={it.content} tone="bubble" />
          </div>,
        );
      } else {
        // agent message: full width without a bubble (flowing like a document). copy button below on hover.
        rows.push(<AssistantMessage key={i} content={it.content} streaming={it.streaming} ts={it.ts} />);
      }
    } else if (it.kind === "thinking") {
      rows.push(<ThinkingBlock key={i} text={it.text} streaming={it.streaming} />);
    } else if (it.kind === "notice") {
      // informational system push (compaction/retry/fallback) — centered, subtle chip.
      // translate coded notices to the active locale; fall back to the pre-rendered text.
      rows.push(
        <div key={i} className="my-0.5 self-center rounded-full border border-line bg-raised/60 px-2.5 py-0.5 text-[11px] text-muted">
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
            className="group flex items-center gap-1.5 self-start rounded-md px-1 py-0.5 font-mono text-[11.5px] text-muted transition-colors hover:bg-raised/60 hover:text-fg-dim"
          >
            <span className={dotCls} />
            <span className="text-fg-dim group-hover:underline">{wid}</span>
            <span title={t(statusLabelKey(it.status))}>{tail}</span>
          </button>
        ) : (
          <div key={i} className="flex items-center gap-1.5 self-start font-mono text-[11.5px] text-muted">
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
        // [&>*]:shrink-0 — prevents the flexbox bug where direct children get vertically squished when the window shrinks (the container scrolls instead).
        className="flex flex-1 flex-col gap-2.5 overflow-y-auto px-5 py-5 [&>*]:shrink-0"
      >
        {rows}
        {waiting && (
          <div role="status" className="rise-in flex items-center gap-2 self-start rounded-2xl rounded-bl-md border border-line bg-raised px-3.5 py-2.5 shadow-[0_1px_2px_rgba(0,0,0,0.22)]">
            <span className="h-1.5 w-1.5 rounded-full bg-accent text-accent led-live" />
            <span className="font-mono text-[11px] text-muted">{t("messageList.thinking")}</span>
          </div>
        )}
      </div>
      {!atBottom && (
        <button
          onClick={toBottom}
          aria-label={t("messageList.scrollToBottom")}
          // fade-in only (opacity) — avoids conflicting with the centering -translate-x-1/2 transform.
          className="fade-in absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-line bg-raised/90 px-2.5 py-1 text-[11px] text-fg-dim shadow-md backdrop-blur transition-colors hover:text-fg"
        >
          <ArrowDown size={12} /> {t("messageList.scrollToBottom")}
        </button>
      )}
    </div>
  );
}

export const MessageList = memo(MessageListImpl);
MessageList.displayName = "MessageList";
