import type { ImageRef } from "@daemon/core/image-input.js";
import { latestSpeedObservation, lastReportedSpeed, speedPendingNextTurn } from "../lib/speed.js";
import { useEffect, useCallback, useMemo, useRef, useState } from "react";
import type { CommandAction } from "@daemon/core/capabilities/commands.js";
import { useStore } from "../store/store.js";
import type { LogItem } from "../store/reduce.js";
import { useDraftStore, EMPTY_DRAFT, clearAcceptedDraft } from "../store/drafts.js";
import { Conversation } from "../views/Conversation.js";
import type { ConversationProps } from "../views/Conversation.js";
import { useT } from "../i18n/provider.js";
import { toast } from "../store/toasts.js";
import { SideConversationDrawer } from "./SideConversationDrawer.js";

// Shared conversation panel for master sessions / workers. Subscribes to transcript, pending, and progress state itself, per kind
// (passing them down as props from App would re-render the whole App on every token delta, so high-frequency subscriptions live here).
// The composer "busy" (stop button) is derived from **authoritative status (running) ‖ optimistic pending** — since master/worker
// run the same code, divergence bugs like "stop button only shows on one side" are structurally impossible.
// EMPTY/EMPTY_PENDING are module constants (selector identity — prevents a new ref on every render).
const EMPTY: LogItem[] = [];
const EMPTY_PENDING: { clientMsgId: string; text: string; images?: ImageRef[] }[] = [];

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
  onSideStart?: (text: string, images?: ImageRef[]) => Promise<string>;
  onSideSend?: (sideId: string, text: string, images?: ImageRef[]) => Promise<void>;
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
  const [draftGeneration,setDraftGeneration] = useState(0);
  const restoreInput = useCallback((text:string,images?:ImageRef[]) => {useDraftStore.getState().setDraft_(id,text,images);setDraftGeneration(n=>n+1);},[id]);
  const initialDraft = useMemo(() => useDraftStore.getState().byPage[id] ?? EMPTY_DRAFT, [id,draftGeneration]);
  const onDraftChange = useCallback((text: string, images?: ImageRef[]) => useDraftStore.getState().setDraft_(id, text, images), [id]);
  const [side, setSide] = useState<{ id: string | null; question: string; images?: ImageRef[] } | null>(null);
  const sideGeneration = useRef(0);
  const sideRef = useRef(side); sideRef.current = side;
  useEffect(() => () => {
    sideGeneration.current++;
    if (sideRef.current?.id) onSideClose?.(sideRef.current.id);
  }, [onSideClose]);
  const askSide = useCallback(async (text: string, images?: ImageRef[]) => {
    if (!onSideStart) return;
    // One Side thread per visible target. A question submitted while it is open becomes a follow-up.
    if (side?.id) { await onSideSend?.(side.id, text, images); return; }
    const acceptedDraft = useDraftStore.getState().byPage[id];
    const generation = ++sideGeneration.current;
    setSide({ id: null, question: text, images });
    await (images?.length ? onSideStart(text, images) : onSideStart(text)).then((sideId) => {
      if (sideGeneration.current === generation) setSide({ id: sideId, question: text, images });
      else { onSideClose?.(sideId); throw new Error("Side opening cancelled"); } // preserve source input when closed while opening
    }).catch((error) => { if (sideGeneration.current === generation) setSide(null); throw error; });
    clearAcceptedDraft(id, text, images, acceptedDraft);
  }, [onSideStart, onSideSend, onSideClose, side, id]);
  const composerCommands = useMemo(() => commands.filter((command) =>
    command.action.type !== "open-panel" || Boolean(onSideStart && !side)), [commands, onSideStart, side]);
  const handleCommandAction = useCallback((action: CommandAction, argument?: string) => {
    if (action.type === "open-panel") {
      // A /side command has no composer draft to keep, so its failure is a toast (the Side button's is inline).
      if (argument) void askSide(argument).catch((error) => toast.error(t("toast.sendFailed"), String(error)));
      return;
    }
    onCommandAction?.(action, argument);
  }, [askSide, onCommandAction, t]);
  const closeSide = useCallback(() => {
    sideGeneration.current++;
    sideRef.current = null;
    if (side?.id) onSideClose?.(side.id);
    setSide(null);
  }, [side, onSideClose]);
  return (
    // @container: the side drawer decides inline vs overlay from this pane's width (audit #9).
    <div className="conversation-pane @container relative flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <Conversation key={draftGeneration} onRestoreInput={kind === "worker" && rest.disabled ? restoreInput : undefined} onRecoverInput={kind === "worker" && rest.disabled ? rest.onRecover : undefined} items={items} kind={kind} loaded={historyLoaded} loadFailed={historyLoadFailed} onRetryHistory={retryHistory} {...rest} controls={rest.controls ? { ...rest.controls, speedPending: speedPendingNextTurn(items), speedObservation: latestSpeedObservation(items), speedLastObservation: lastReportedSpeed(items) } : undefined} commands={composerCommands} busy={busy} initialText={initialDraft.text} initialImages={initialDraft.images} onDraftChange={onDraftChange} onSideSend={onSideStart && !side ? askSide : undefined} onCommandAction={handleCommandAction} pending={pending} pendingQueued={statusRunning} />
      </div>
      {side && (
        <SideConversationDrawer
          sourceKind={kind}
          sourceId={id}
          speed={rest.controls?.speed ?? rest.controls?.defaultSpeed}
          defaultSpeed={rest.controls?.defaultSpeed}
          provider={rest.controls?.provider}
          model={rest.controls?.model}
          sideId={side.id}
          openingQuestion={side.question}
          openingImages={side.images}
          onSend={async (sideId, text, images) => { await (images?.length ? onSideSend?.(sideId, text, images) : onSideSend?.(sideId, text)); }}
          onStop={(sideId) => onSideStop?.(sideId)}
          onClose={closeSide}
        />
      )}
    </div>
  );
}
