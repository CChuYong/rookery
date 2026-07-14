import { useCallback, useMemo, useRef, useState } from "react";
import { Clock } from "lucide-react";
import type { CommandAction } from "@daemon/core/capabilities/commands.js";
import { useStore } from "../store/store.js";
import type { LogItem } from "../store/reduce.js";
import { useDraftStore } from "../store/drafts.js";
import { Conversation } from "../views/Conversation.js";
import type { ConversationProps } from "../views/Conversation.js";
import { useT } from "../i18n/provider.js";
import { SideConversationDrawer } from "./SideConversationDrawer.js";

// Shared conversation panel for master sessions / workers. Subscribes to transcript, pending, and progress state itself, per kind
// (passing them down as props from App would re-render the whole App on every token delta, so high-frequency subscriptions live here).
// The composer "busy" (stop button) is derived from **authoritative status (running) ‖ optimistic pending** — since master/worker
// run the same code, divergence bugs like "stop button only shows on one side" are structurally impossible.
// EMPTY/EMPTY_PENDING are module constants (selector identity — prevents a new ref on every render).
const EMPTY: LogItem[] = [];
const EMPTY_PENDING: { clientMsgId: string; text: string }[] = [];

export function ConversationPane({
  kind,
  id,
  onRetryHistory,
  onSideStart,
  onSideSend,
  onSideStop,
  onSideClose,
  onCommandAction,
  commands = [],
  ...rest
}: {
  kind: "master" | "worker";
  id: string;
  onRetryHistory?: (kind: "master" | "worker", id: string) => void;
  onSideStart?: (text: string) => Promise<string>;
  onSideSend?: (sideId: string, text: string) => void;
  onSideStop?: (sideId: string) => void;
  onSideClose?: (sideId: string) => void;
} & Omit<ConversationProps, "items" | "busy" | "kind" | "loaded" | "loadFailed" | "onRetryHistory" | "onSideSend">): JSX.Element {
  const t = useT();
  const items = useStore((st) => (kind === "master" ? st.logsBySession[id] : st.workerLogs[id]) ?? EMPTY);
  // "Pending" messages sent mid-turn — they convert to committed and disappear when the echo (clientMsgId) arrives.
  const pending = useStore((st) => (kind === "master" ? st.pendingBySession[id] : st.pendingByWorker[id]) ?? EMPTY_PENDING);
  // Authoritative progress state: master = running map (master.status), worker = FleetRow.status. Both are server-authoritative. A boolean selector, so it only re-renders on flip.
  const statusRunning = useStore((st) => (kind === "master" ? !!st.running[id] : st.fleet[id]?.status === "running"));
  const busy = statusRunning || pending.length > 0; // immediate feedback comes from pending (the moment you send), sustained state from running (turn start to end)
  // History-fetch state for this conversation (audit #43) — gates MessageList's skeleton/error/empty-hint split.
  const historyLoaded = useStore((st) => st.historyLoaded[id] ?? false);
  const historyLoadFailed = useStore((st) => st.historyLoadFailed[id] ?? false);
  const retryHistory = useCallback(() => onRetryHistory?.(kind, id), [onRetryHistory, kind, id]);

  // draft is read non-reactively, only when id changes (we write to the store on every keystroke but don't subscribe). App uses key={id}, so it remounts on switch.
  const initialText = useMemo(() => useDraftStore.getState().byPage[id] ?? "", [id]);
  const onDraftChange = useCallback((text: string) => useDraftStore.getState().setDraft_(id, text), [id]);
  const [side, setSide] = useState<{ id: string | null; question: string } | null>(null);
  const sideGeneration = useRef(0);
  const askSide = useCallback((text: string) => {
    if (!onSideStart) return;
    // One Side thread per visible target. A question submitted while it is open becomes a follow-up.
    if (side?.id) { onSideSend?.(side.id, text); return; }
    const generation = ++sideGeneration.current;
    setSide({ id: null, question: text });
    void onSideStart(text).then((sideId) => {
      if (sideGeneration.current === generation) setSide({ id: sideId, question: text });
      else onSideClose?.(sideId); // closed while the provider fork was opening
    }).catch(() => { if (sideGeneration.current === generation) setSide(null); });
  }, [onSideStart, onSideSend, onSideClose, side]);
  const composerCommands = useMemo(() => commands.filter((command) =>
    command.action.type !== "open-panel" || Boolean(onSideStart && !side)), [commands, onSideStart, side]);
  const handleCommandAction = useCallback((action: CommandAction, argument?: string) => {
    if (action.type === "open-panel") {
      if (argument) askSide(argument);
      return;
    }
    onCommandAction?.(action, argument);
  }, [askSide, onCommandAction]);
  const closeSide = useCallback(() => {
    sideGeneration.current++;
    if (side?.id) onSideClose?.(side.id);
    setSide(null);
  }, [side, onSideClose]);
  return (
    <div className="relative flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <Conversation items={items} kind={kind} loaded={historyLoaded} loadFailed={historyLoadFailed} onRetryHistory={retryHistory} {...rest} commands={composerCommands} busy={busy} initialText={initialText} onDraftChange={onDraftChange} onSideSend={onSideStart && !side ? askSide : undefined} onCommandAction={handleCommandAction} />
        {pending.length > 0 && (
          <div className="flex flex-col gap-1 px-4 pb-2">
            {pending.map((p) => (
              <div key={p.clientMsgId} className="ml-auto max-w-[80%] rounded-xl border border-dashed border-line bg-ink/30 px-3 py-2 text-[13px] text-fg-dim opacity-70">
                <span className="mr-2 inline-flex items-center gap-1 rounded bg-line/40 px-1.5 py-0.5 text-[10px] text-muted"><Clock size={10} /> {t("conversation.pendingBadge")}</span>
                {p.text}
              </div>
            ))}
          </div>
        )}
      </div>
      {side && (
        <SideConversationDrawer
          sourceKind={kind}
          sideId={side.id}
          openingQuestion={side.question}
          onSend={(sideId, text) => onSideSend?.(sideId, text)}
          onStop={(sideId) => onSideStop?.(sideId)}
          onClose={closeSide}
        />
      )}
    </div>
  );
}
