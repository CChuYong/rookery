import type { Catalog } from "../../types.js";
export default {
  "dataConsent.title": "데이터 전송 안내",
  "dataConsent.body": "이 앱은 입력한 프롬프트, 저장소 코드·diff, Slack 연동 시 채널 텍스트를 선택한 LLM 제공자로 전송해요 — 기본은 Anthropic(Claude)이고, codex 백엔드로 설정한 세션·워커·자동화·Slack 스레드는 OpenAI로 전송돼요. 로컬 데이터는 ~/.rookery에 저장돼요.",
  "dataConsent.accept": "동의하고 계속",
  "dataConsent.saveFailed": "저장하지 못했어요 — 다시 시도해주세요.",
} satisfies Catalog;
