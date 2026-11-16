import type { Catalog } from "../../types.js";
// Copy glossary (audit T10, 2026-11-15) — one term per concept in each locale. New copy must reuse these words;
// Korean copy is 해요체 throughout, with no 반말 and no "당신" (drop the subject instead).
//
// | Concept                                   | ko                         | en                          |
// |-------------------------------------------|----------------------------|-----------------------------|
// | Abort the current turn (session kept)     | 중단 / 중단됨              | Interrupt / Interrupted     |
// | End a worker (terminal, worktree kept)    | 중지 / 중지됨              | Stop / Stopped              |
// | Master hits a budget/turn cap (no stop    | 이 세션을 계속할지         | review whether to continue  |
// | verb exists for a master session)         | 검토하세요                 | this session                |
// | Put files back to a turn checkpoint       | 체크포인트로 복원 / 복원   | Restore checkpoint / Restore|
// | Throw away git working-tree changes       | 변경 사항 폐기 / 폐기      | Discard changes / Discard   |
// | Throw away unsaved edits (forms, editor)  | 변경 버리기, 버리고 닫기   | Discard changes, Discard    |
// | Claude/Codex choice                       | 백엔드                     | Backend                     |
// | Model reasoning setting                   | 추론 강도                  | Effort                      |
// | Create a worker                           | 스폰 (워커를 스폰해요)     | Spawn                       |
// | Registered git repository                 | 레포                       | repo / Repo                 |
// | Per-worker git checkout                   | 워크트리                   | worktree                    |
// | All workers                               | 워커 플릿                  | worker fleet                |
// | Recorded conversation                     | 대화 기록                  | transcript                  |
// | Code changes / diff                       | 변경 사항                  | changes / diff              |
// | Branch a worktree starts from             | 기준 브랜치                | base branch                 |
// | A session/worker's cwd                    | 작업 폴더                  | working folder              |
// | Worker finished all assigned work         | 대기 중                    | Idle                        |
// | Claude Dynamic Workflow / its phases      | 워크플로 / 단계            | Workflow / Phase            |
// | Provider-native nested subagent           | 하위 에이전트              | Sub-agent                   |
// | Side conversation (/side)                 | 사이드 질문                | Side question               |
// | Speed tiers                               | 표준 / 빠름                | Standard / Fast             |
// | Permission modes                          | 권한 우회 / 기본 /         | Bypass Permissions /        |
// |                                           | 계획 모드 / 편집 자동 승인 | Default / Plan Mode /       |
// |                                           |                            | Accept Edits                |
// | 5-hour usage window (account-wide)        | 5시간 한도                 | 5h window                   |
// | Product name                              | Rookery                    | Rookery                     |
//
// Kept in English in both locales (proper nouns or technical identifiers): Rookery, Claude, Codex, Slack, Linear,
// Git, MCP, Capability Center / Capabilities, capability, pack, digest, secret, cron, and CLI commands/paths
// (codex login, ~/.rookery, rookery/<id>) — those stay lowercase as typed. The master's default name "rookery"
// is a literal setting value, not the product name.
// Renderer notice.* keys, params and wording mirror the daemon catalog (src/core/i18n.ts) byte for byte — change both.
export default {
  "common.save": "저장",
  "common.saved": "저장됨",
  "common.cancel": "취소",
  "common.close": "닫기",
  "common.loading": "불러오는 중…",
  "common.refresh": "새로고침",
  "common.delete": "삭제",
  "common.confirm": "확인",
  "common.connect": "연결",
  "common.connected": "연결됨",
  "common.retry": "다시 시도",
  "common.moreActions": "더보기",
  "common.effortLow": "낮음",
  "common.effortMedium": "보통",
  "common.effortHigh": "높음",
  "common.effortXhigh": "매우 높음",
  "common.effortMax": "최대",
  "common.effortUltra": "울트라",
  "common.noLimit": "제한 없음",
} satisfies Catalog;
