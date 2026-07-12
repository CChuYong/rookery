import type { Catalog } from "../../types.js";
export default {
  "sideConversation.title": "Side question",
  "sideConversation.answering": "Answering",
  "sideConversation.masterContext": "Main session context · read-only",
  "sideConversation.workerContext": "This worker's context · live worktree · read-only",
  "sideConversation.masterLive": "The main task keeps running.",
  "sideConversation.workerLive": "The worker keeps changing the same worktree, so read results may change.",
  "sideConversation.waitingPlaceholder": "You can follow up when this answer finishes",
  "sideConversation.followupPlaceholder": "Follow-up question…",
} satisfies Catalog;
