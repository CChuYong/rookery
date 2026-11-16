import { useCallback, useEffect, useMemo, useRef } from "react";
import { useFocusTrap } from "../lib/useFocusTrap.js";
import type { ImageRef } from "@daemon/core/image-input.js";
import {
  useDraftStore,
  EMPTY_DRAFT,
  clearAcceptedDraft,
  sideDraftKey,
} from "../store/drafts.js";
import type { SpeedPreference } from "@daemon/core/speed.js";
import { SpeedControl } from "./SpeedControl.js";
import { latestSpeedObservation } from "../lib/speed.js";
import { Loader2, LockKeyhole, X } from "lucide-react";
import { useStore } from "../store/store.js";
import type { LogItem } from "../store/reduce.js";
import { MessageList } from "./MessageList.js";
import { Composer } from "./Composer.js";
import { Button } from "../ui/button.js";
import { useT } from "../i18n/provider.js";
import { withShortcut } from "../lib/shortcuts.js";

const EMPTY: LogItem[] = [];

export interface SideConversationDrawerProps {
  speed?: SpeedPreference | null;
  defaultSpeed?: SpeedPreference;
  provider?: string;
  model?: string;
  sourceKind: "master" | "worker";
  sourceId: string;
  sideId: string | null;
  openingQuestion: string;
  openingImages?: ImageRef[];
  onSend: (sideId: string, text: string, images?: ImageRef[]) => Promise<void>;
  onStop: (sideId: string) => void;
  onClose: () => void;
}

export function SideConversationDrawer({
  speed,
  defaultSpeed,
  provider,
  model,
  sourceKind,
  sourceId,
  sideId,
  openingQuestion,
  openingImages,
  onSend,
  onStop,
  onClose,
}: SideConversationDrawerProps): JSX.Element {
  const t = useT();
  const side = useStore((s) =>
    sideId ? s.sideConversations[sideId] : undefined,
  );
  const status = side?.status ?? "opening";
  const items =
    side?.items ??
    (openingQuestion || openingImages?.length
      ? [
          {
            images: openingImages,
            kind: "message",
            role: "user",
            content: openingQuestion,
          } as LogItem,
        ]
      : EMPTY);
  const draftKey = sideDraftKey(sourceKind, sourceId);
  const initialDraft = useMemo(
    () => useDraftStore.getState().byPage[draftKey] ?? EMPTY_DRAFT,
    [draftKey],
  );
  const onDraftChange = useCallback(
    (text: string, images?: ImageRef[]) =>
      useDraftStore.getState().setDraft_(draftKey, text, images),
    [draftKey],
  );
  const running = status === "opening" || status === "running";
  // Focus (audit #73): opening moves focus to the drawer's composer, closing returns it to where it was (the main
  // composer that ran /side). Tab is trapped only in the overlay layout, where the drawer covers the conversation and is
  // effectively modal; inline beside the conversation, Tab moves on normally.
  const asideRef = useRef<HTMLElement>(null);
  useFocusTrap(asideRef, {
    trapWhen: () => !!asideRef.current && getComputedStyle(asideRef.current).position === "absolute",
    initialFocus: () => asideRef.current?.querySelector<HTMLElement>('[contenteditable="true"]'),
  });
  // When the element that opened the drawer is gone by the time it closes (the composer's Side button hides while a
  // drawer is open), land on the conversation's own composer rather than <body>. Declared after useFocusTrap so this
  // cleanup runs after its restore attempt.
  useEffect(() => {
    const pane = asideRef.current?.closest(".conversation-pane");
    return () => {
      const active = document.activeElement;
      if (active && active !== document.body && active.isConnected) return;
      pane?.querySelector<HTMLElement>('[contenteditable="true"]')?.focus();
    };
  }, []);

  return (
    <aside
      ref={asideRef}
      aria-label={t("sideConversation.title")}
      // Escape closes the drawer unless something inside already used it (a composer popup or the model menu).
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.defaultPrevented) return;
        e.preventDefault();
        onClose();
      }}
      // Inline beside the conversation only when the conversation pane (a container, not the viewport) has room for
      // both; otherwise it overlays the pane instead of squeezing the conversation to a sliver (audit #9).
      className="side-conversation-drawer absolute inset-0 z-30 flex min-h-0 flex-col border-l border-line bg-surface shadow-2xl @min-[760px]:relative @min-[760px]:inset-auto @min-[760px]:z-auto @min-[760px]:w-[360px] @min-[760px]:shrink-0 @min-[760px]:shadow-none"
    >
      <header className="flex h-10 shrink-0 items-center gap-2 px-3">
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="text-body font-medium text-fg">
            {t("sideConversation.title")}
          </span>
          {running && (
            <Loader2
              size={12}
              className="animate-spin text-accent"
              aria-label={t("sideConversation.answering")}
            />
          )}
          <span className="flex min-w-0 items-center gap-1 truncate text-meta text-faint">
            <LockKeyhole size={12} className="shrink-0" />
            {t(
              sourceKind === "worker"
                ? "sideConversation.workerContext"
                : "sideConversation.masterContext",
            )}
          </span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          aria-label={t("common.close")}
          title={withShortcut(t("common.close"), "Esc")}
          onClick={onClose}
        >
          <X size={14} />
        </Button>
      </header>
      <div className="border-b border-line bg-raised/40 px-3 py-1.5 text-meta text-muted">
        {t(
          sourceKind === "worker"
            ? "sideConversation.workerLive"
            : "sideConversation.masterLive",
        )}
      </div>
      <MessageList items={items} loaded />
      <div className="border-t border-line bg-surface p-2.5">
        <Composer
          leftSlot={
            speed !== undefined ? (
              <SpeedControl
                speed={speed}
                defaultSpeed={defaultSpeed}
                provider={provider}
                model={model ?? ""}
                observation={latestSpeedObservation(items)}
              />
            ) : undefined
          }
          key={draftKey}
          initialText={initialDraft.text}
          initialImages={initialDraft.images}
          onDraftChange={onDraftChange}
          onDropFiles={(files) =>
            files
              .map((file) => window.rookery.getPathForFile(file))
              .filter(Boolean)
          }
          onSend={async (text, images) => {
            if (sideId) {
              const acceptedDraft = useDraftStore.getState().byPage[draftKey];
              await (images?.length
                ? onSend(sideId, text, images)
                : onSend(sideId, text));
              clearAcceptedDraft(draftKey, text, images, acceptedDraft);
            }
          }}
          busy={running}
          onStop={sideId ? () => onStop(sideId) : undefined}
          disabled={!sideId || status === "closed"}
          placeholder={
            running
              ? t("sideConversation.waitingPlaceholder")
              : t("sideConversation.followupPlaceholder")
          }
          className="bg-ink/30"
        />
      </div>
    </aside>
  );
}
