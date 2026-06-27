import { useCallback, useMemo } from "react";
import { Clock } from "lucide-react";
import { useStore } from "../store/store.js";
import type { LogItem } from "../store/reduce.js";
import { useDraftStore } from "../store/drafts.js";
import { Conversation } from "../views/Conversation.js";
import type { ConversationProps } from "../views/Conversation.js";
import { useT } from "../i18n/provider.js";

// Shared conversation panel for master sessions / workers. Subscribes to transcript, pending, and progress state itself, per kind
// (passing them down as props from App would re-render the whole App on every token delta, so high-frequency subscriptions live here).
// The composer "busy" (stop button) is derived from **authoritative status (running) ‖ optimistic pending** — since master/worker
// run the same code, divergence bugs like "stop button only shows on one side" are structurally impossible.
// EMPTY/EMPTY_PENDING are module constants (selector identity — prevents a new ref on every render).
const EMPTY: LogItem[] = [];
const EMPTY_PENDING: { clientMsgId: string; text: string }[] = [];

export function ConversationPane({ kind, id, ...rest }: { kind: "master" | "worker"; id: string } & Omit<ConversationProps, "items" | "busy">): JSX.Element {
  const t = useT();
  const items = useStore((st) => (kind === "master" ? st.logsBySession[id] : st.workerLogs[id]) ?? EMPTY);
  // "Pending" messages sent mid-turn — they convert to committed and disappear when the echo (clientMsgId) arrives.
  const pending = useStore((st) => (kind === "master" ? st.pendingBySession[id] : st.pendingByWorker[id]) ?? EMPTY_PENDING);
  // Authoritative progress state: master = running map (master.status), worker = FleetRow.status. Both are server-authoritative. A boolean selector, so it only re-renders on flip.
  const statusRunning = useStore((st) => (kind === "master" ? !!st.running[id] : st.fleet[id]?.status === "running"));
  const busy = statusRunning || pending.length > 0; // immediate feedback comes from pending (the moment you send), sustained state from running (turn start to end)

  // draft is read non-reactively, only when id changes (we write to the store on every keystroke but don't subscribe). App uses key={id}, so it remounts on switch.
  const initialText = useMemo(() => useDraftStore.getState().byPage[id] ?? "", [id]);
  const onDraftChange = useCallback((text: string) => useDraftStore.getState().setDraft_(id, text), [id]);
  return (
    <>
      <Conversation items={items} {...rest} busy={busy} initialText={initialText} onDraftChange={onDraftChange} />
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
    </>
  );
}
