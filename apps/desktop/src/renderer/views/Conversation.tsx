import { memo } from "react";
import type { LogItem } from "../store/reduce.js";
import { MessageList } from "../components/MessageList.js";
import type { InteractionAnswer } from "../components/InteractionCard.js";
import { Composer } from "../components/Composer.js";
import type { ComposerProps } from "../components/Composer.js";

// The composer types moved to Composer, but existing consumers (ConversationPane, etc.)
// import them from Conversation, so we re-export them here.
export type { ComposerControls, SlashCommand } from "../components/Composer.js";

export interface ConversationProps extends ComposerProps {
  items: LogItem[];
  kind?: "master" | "worker"; // which loaded-and-empty hint MessageList shows (audit #43)
  loaded?: boolean; // history fetch for this conversation has succeeded at least once — passed through to MessageList
  loadFailed?: boolean; // history fetch was rejected and hasn't succeeded since — passed through to MessageList
  onRetryHistory?: () => void; // re-fires the failed history fetch
  onOpenFile?: (path: string) => void; // click a tool-card filename chip → open the file tab
  onSelectWorker?: (id: string) => void; // click a spawned worker marker/card → navigate to that worker's view (repo tab) (master conversation only)
  onRespond?: (requestId: string, res: InteractionAnswer) => void; // respond to an approval/question card (master conversation only)
}

// Message list + input composer. The composer body (editor/popup/attachments/controls) is owned by Composer.
function ConversationImpl({ items, kind, loaded, loadFailed, onRetryHistory, onOpenFile, onSelectWorker, onRespond, ...composer }: ConversationProps): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <MessageList items={items} kind={kind} loaded={loaded} loadFailed={loadFailed} onRetryHistory={onRetryHistory} onOpenFile={onOpenFile} onSelectWorker={onSelectWorker} onRespond={onRespond} />
      <div className="border-t border-line bg-surface px-3 py-2.5">
        <Composer {...composer} />
      </div>
    </div>
  );
}

export const Conversation = memo(ConversationImpl);
Conversation.displayName = "Conversation";
