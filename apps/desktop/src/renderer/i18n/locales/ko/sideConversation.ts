import type { Catalog } from "../../types.js";
export default {
  "sideConversation.title": "Side 질문",
  "sideConversation.answering": "답변 중",
  "sideConversation.masterContext": "메인 세션의 문맥 · 읽기 전용",
  "sideConversation.workerContext": "이 워커의 문맥 · live worktree · 읽기 전용",
  "sideConversation.masterLive": "메인 작업은 계속 실행됩니다.",
  "sideConversation.workerLive": "워커가 같은 worktree에서 계속 작업하므로 읽는 내용이 바뀔 수 있습니다.",
  "sideConversation.waitingPlaceholder": "답변이 끝나면 후속 질문할 수 있어요",
  "sideConversation.followupPlaceholder": "후속 질문…",
  "sideConversation.commandDescription": "현재 작업을 멈추지 않고 별도로 질문합니다.",
  "sideConversation.commandArgumentHint": "<질문>",
} satisfies Catalog;
