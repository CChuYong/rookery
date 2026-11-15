# Desktop UI/UX 감사 — 2026-11-15

범위: `apps/desktop` renderer 전체. 화면을 여러 폭(920x600 / 1024x700 / 1440 / 1920x1080)으로 캡처하고 패널을 열고 닫고 크기를 바꾸면서 찍은 스크린샷 47장과 코드를 함께 봤습니다. 렌즈는 9개입니다: visual-consistency, state-coverage, interaction-feedback, ia-navigation, copy-i18n, a11y-keyboard, pixel-pass, layout-resize, ux-complexity.

- 확정된 발견 212건 중 같은 문제를 다룬 72건을 병합해서 **140개 항목**으로 정리했습니다. 병합된 항목에는 렌즈를 모두 표기했습니다.
- 기각된 발견 18건은 부록에 사유와 함께 남겼습니다.
- 경로 표기: `renderer/` = `apps/desktop/src/renderer/`, `main/` = `apps/desktop/src/main/`. "shot NN"은 감사용 스크린샷 번호입니다(예: shot 02 = `02-session-1440.png`).

---

## 요약

| 심각도 | 항목 수 |
|---|---|
| high | 6 |
| medium | 101 |
| low | 33 |
| **합계** | **140** (원본 확정 212건) |

effort: S 101 · M 39 · L 0

**가장 심각한 문제는 도크 레이아웃입니다** (#1–#6). 대화 패널에 최소 폭이 없어서 한 글자씩 세로로 찌그러지고, 우측 패널에는 최대 폭이 없습니다. 창을 줄이면 우측 패널이 말없이 사라지고, 좁은 창에 갔다가 돌아오면 우측 패널이 화면 절반 폭으로 굳어서 저장됩니다. 사용자가 "패널 열고 닫거나 크기 키우고 줄였을 때" 겪는 이상 동작은 대부분 이 6건과 #7–#14, #79–#81에 모여 있습니다.

### Quick wins (severity high/medium AND effort S, 75건)

- **도크/레이아웃**: #1 대화 패널 최소 폭, #3 우측 패널 최대 폭, #7 좁은 창에서 내린 사용자 숨김이 덮어써짐, #8 부분 열림 토글 상태, #9 Side drawer breakpoint, #11 패널 토글 상태 표시, #12 대화 탭이 나타났다 사라짐, #13 워커 기본 탭이 Activity, #14 스크롤바가 칼럼 중간에 있음
- **에디터 탭**: #2 overflow 속에 숨는 활성 탭, #15 dirty 점, #16 활성 탭 스타일, #17 에러 상태 에디터가 편집 가능, #18 Diff 로딩/에러/빈 상태
- **헤더/내비게이션**: #10 back/forward 사라짐, #19 접힌 레일, #20 아이콘 다의성(벨·↺), #21 좁은 폭에서 Revert 사라짐, #22 헤더 컨트롤 순서, #23 Repos 빈 메인, #24 Open in 분할 버튼, #25 상태바 사용량 수치, #26 ContextMenu 잘림, #27 Resources 팝오버가 남음
- **컴포저**: #28 placeholder, #29 아이콘 tooltip / Side question, #30 대기 버블 크기, #31 대기 버블 위치, #32 이중 에러, #33 비활성 사유, #34 Recover 진행 표시, #35 명령 목록 실패, #36 티켓 검색 실패, #37 예산 무시
- **Git**: #38 Changes 중복, #39 가짜 chevron, #40 History 갱신 안 됨, #41 Push 무피드백
- **상태 처리**: #42 사이드바 로딩, #43 콜드스타트 깜빡임, #44 Retry 무반응, #45 설정 버튼 무반응, #46 사용량 무한 로딩, #47 '확인 중' 고착, #48 워크플로 기록 재시도, #49 Catalog 액션 에러
- **Settings/Automation**: #50 MCP 토큰 재생성, #51 마스터 모델 위치, #52 낡은 카피, #53 ISO 시각·하드코딩 접두어, #54 자동화 카피
- **Capability**: #63 명칭 혼재, #64 내부 용어 노출
- **시각/피드백**: #55 Usage 미터 색, #56 Pin/Archive 낙관적 갱신
- **카피**: #57 삭제 확인 문장, #58 중지 용어, #59 상태 태그, #60 'Session · 5h', #61 Revert 용어, #62 backend/provider, #65 스폰 화면 영어, #66 Workflow 용어
- **키보드/a11y**: #67 ContextMenu 포커스 복원, #68 FileTree 키보드 메뉴, #69 FileTree 필터 키보드, #70 팝업 스크롤, #71 overflow chevron, #72 aria-expanded, #73 Side drawer Esc, #74 InteractionCard 포커스, #75 벨 팝오버 포커스, #76 IME Enter, #77 레이블 없는 input, #78 행 액션 이름

---

## 우선순위 인벤토리

| # | 제목 | severity | effort | 컴포넌트 |
|---|---|---|---|---|
| 1 | 대화 패널 최소 폭이 없어 sash를 끌면 한 글자씩 세로로 찌그러짐 | high | S | panels.tsx, WorkspaceDock |
| 2 | 창을 줄이면 활성 에디터 탭이 overflow chevron 안으로 숨고 라벨이 잘림 | high | S | RookeryTab, dockview-theme.css, WorkspaceDock |
| 3 | 우측 패널에 최대 폭이 없어 넓은 화면에서 빈 패널이 과하게 넓어지고 에디터를 누름 | high | S | WorkspaceDock, panels.tsx |
| 4 | 좁은 창에서 우측 패널이 말없이 제거되고 헤더 토글은 '사용자가 끈 것'처럼 보임 | high | M | WorkspaceDock, layout-budget, WorkspaceHeaders, App |
| 5 | 좁은 창에 갔다 돌아오면 우측 패널이 320px가 아니라 절반 폭으로 다시 붙고 그대로 저장됨 | high | M | WorkspaceDock, dockview-core |
| 6 | 우측 패널과 터미널 사이에 빈 영역(dead zone)이 생김 | high | M | dockview layout, default-template |
| 7 | 좁은 창에서 사용자가 숨긴 우측 패널이 창이 넓어지면 다시 열림 | medium | S | WorkspaceDock, dock-panels |
| 8 | Files/Git 중 하나만 닫아도 우측 토글이 '꺼짐'으로 보이고 클릭 결과가 반대 | medium | S | dock-panels, WorkspaceHeaders |
| 9 | Side conversation drawer가 viewport 기준 breakpoint로 360px 고정되어 좁은 dock에서 대화를 누름 | medium | S | SideConversationDrawer, ConversationPane |
| 10 | 사이드바 폭이 240px 미만이면 뒤로/앞으로 버튼이 사라지고 단축키도 없음 | medium | S | App, layout-budget |
| 11 | 패널 토글이 열림/닫힘 상태를 tooltip·aria-pressed로 알리지 않음 | medium | S | WorkspaceHeaders, App |
| 12 | 대화 탭이 단독일 때는 숨었다가 파일을 열면 나타나 본문이 32px 밀림 | medium | S | dockview-theme.css, RookeryTab |
| 13 | 워커 페이지 우측 패널이 대개 비어 있는 Activity 탭으로 시작함 | medium | S | default-template, WorkspaceDock |
| 14 | 대화 스크롤바가 720px 칼럼 끝(화면 중간)에 있고, 칼럼 밖 여백에서는 휠 스크롤이 안 됨 | medium | S | MessageList |
| 15 | dock 모드 에디터 탭에 '저장 안 됨' 표시가 없음 | medium | S | RookeryTab |
| 16 | 에디터 탭 활성 표시가 거의 없고 탭 폭이 과함 | medium | S | TabBar |
| 17 | 파일을 못 열었거나 용량을 넘은 상태에서도 빈 Monaco가 편집·저장 가능함(파일을 덮어쓸 수 있음) | medium | S | MonacoEditor |
| 18 | Diff 탭에 로딩·에러·변경 없음 상태가 없음 | medium | S | MonacoDiff |
| 19 | 접힌 사이드바 레일이 상태바 아이콘만 반복하고 세션/레포 내비가 없음 | medium | S | App, StatusBar |
| 20 | 비슷한 아이콘이 서로 다른 기능에 쓰임: 벨 2종, RotateCcw 3종 | medium | S | App, StatusBar, AttentionBell, WorkspaceHeaders |
| 21 | 좁은 폭에서 헤더의 Revert·백그라운드 Stop·metrics가 대체 경로 없이 사라짐 | medium | S | WorkspaceHeaders, globals.css |
| 22 | 세션 헤더와 워커 헤더의 오른쪽 컨트롤 순서가 반대 | medium | S | WorkspaceHeaders |
| 23 | Repos 메인 영역이 헤더도 액션도 없는 빈 화면 | medium | S | App, RepoTree |
| 24 | 'Open in ▾'에서 텍스트를 누르면 메뉴가 열리고, 실제로 여는 쪽은 라벨 없는 아이콘 | medium | S | OpenInAppMenu |
| 25 | 상태바 사용량 수치가 클릭·tooltip이 없어 상세 패널에 갈 수 없음 | medium | S | StatusBar, UsagePanel |
| 26 | ContextMenu가 viewport 경계를 고려하지 않아 아래·오른쪽 끝에서 잘림 | medium | S | ContextMenu |
| 27 | Resources 팝오버가 페이지를 이동해도 닫히지 않고 폼을 가림 | medium | S | ResourceMonitor |
| 28 | 컴포저 placeholder가 단축키 안내 3개를 담아 길고 잘림 | medium | S | Composer, i18n app |
| 29 | 컴포저 아이콘 버튼(따로 질문·첨부·전송)에 tooltip이 없고, Side question은 이름이 세 개 | medium | S | Composer, SideConversationDrawer, commands.ts |
| 30 | 전송 대기/실패 버블(12px)과 확정 버블(14px)의 글자 크기가 달라 echo 순간 튐 | medium | S | MessageList, ConversationPane |
| 31 | 전송 직후 'Queued' 버블이 입력창 아래에 렌더링됨 | medium | S | ConversationPane, Conversation |
| 32 | 전송 실패 시 toast와 이미지용 인라인 에러가 동시에 뜸 | medium | S | Composer, App, AutomationForm |
| 33 | 비활성 버튼이 이유를 알리지 않음(pointer-events-none 때문에 tooltip도 막힘) | medium | S | ui/button, Composer, GitChanges |
| 34 | Recover(하드킬) 버튼에 진행 상태와 중복 클릭 방지가 없음 | medium | S | Composer, App |
| 35 | 슬래시 명령 목록 로드 실패 시 이전 대상의 명령이 남고 '/' 팝업에 빈 상태가 없음 | medium | S | App, PromptEditor |
| 36 | 스폰 페이지: 티켓 검색 실패가 '결과 없음'으로 보이고 브랜치 선택기는 조용히 사라짐 | medium | S | WorkerSpawnPage, App |
| 37 | 스폰 페이지 비용 예산에 잘못된 값을 넣으면 경고 없이 무시됨 | medium | S | WorkerSpawnPage |
| 38 | Git 패널에 'Changes'가 세 번 나오고 파일명·경로가 중복 표시됨 | medium | S | GitChanges, RightSidebar |
| 39 | Git 섹션 헤더 chevron이 접히지 않는 가짜 어포던스 | medium | S | GitChanges |
| 40 | Git History가 갱신되지 않고 새로고침도 History에 적용되지 않음 | medium | S | GitChanges, GitHistory |
| 41 | Git Push에 진행 표시, 성공 피드백, 중복 실행 방지가 없음 | medium | S | GitChanges |
| 42 | Sessions·Repos 사이드바가 로딩 중 완전히 비어 있음 | medium | S | Sessions, RepoTree |
| 43 | 앱 시작 시 마지막 세션을 복원하기 전에 New Session 화면이 잠깐 보임 | medium | S | App, NewSessionPage |
| 44 | 사이드바 '다시 시도'에 진행 표시도 실패 피드백도 없음 | medium | S | App, Sessions, RepoTree |
| 45 | settings.get이 실패하면 설정 버튼은 활성으로 보이는데 페이지가 안 열림 | medium | S | App, SettingsPage |
| 46 | 사용량 데이터가 비어 있으면 '불러오는 중…'이 끝나지 않음 | medium | S | UsagePanel, App |
| 47 | auth/integrations 상태 요청이 실패하면 설정이 '확인 중…'에 영원히 머묾 | medium | S | SettingsPage, App |
| 48 | 워크플로 에이전트 기록 로드 실패에 재시도 수단이 없음 | medium | S | WorkflowRuns |
| 49 | Catalog 탭에서 작업이 실패하면 탭 전체가 '로드 실패' 화면으로 바뀜 | medium | S | CapabilityLibraryTab |
| 50 | MCP 토큰 재생성이 확인 없이 실행되고 성공 toast가 'Key saved'로 뜸 | medium | S | SettingsPage, App |
| 51 | Claude 마스터 기본 모델은 Slack 탭에, 나머지 모델 기본값은 Models 탭에 흩어져 있음 | medium | S | SettingsPage |
| 52 | 설정 카피에 사라진 UI 이름과 실제 범위와 다른 제목이 남아 있음 | medium | S | SettingsPage, i18n settings |
| 53 | 자동화 '다음 실행'이 UTC ISO 원문 그대로 나오고, 트리거 접두어는 영어로 하드코딩됨 | medium | S | AutomationPage |
| 54 | 자동화 폼 카피가 오해를 부르거나 내부 키를 노출함 | medium | S | AutomationForm, AutomationPage, RunAutomationDialog |
| 55 | Usage 미터가 평소엔 주황, 70%부터 하늘색이라 위험도 색 순서가 뒤집힘 | medium | S | UsagePanel |
| 56 | Pin/Archive가 응답 왕복 전까지 아무 반응이 없음 | medium | S | App, Sessions, RepoTree |
| 57 | 워커/세션 삭제 확인 문장에서 동사가 빠지고 조사가 틀림 | medium | S | RepoTree, Sessions, i18n |
| 58 | 중지 관련 용어(중지/중단/종료/End/Stop)가 뒤섞여 턴 중단과 워커 중지를 구분하지 못함 | medium | S | Composer, RepoTree, i18n |
| 59 | 같은 상태가 'STOP' / '→ stop' / 'Stopped' 세 가지로 표기되고 ko에서도 영어 약어로 남음 | medium | S | status.ts, RepoTree, MessageList, StatusBadge |
| 60 | 상태바 'Session · 5h'가 앱의 Session 개념과 겹치고 provider 탭이 텍스트처럼 보임 | medium | S | UsagePanel, StatusBar |
| 61 | 'Revert'가 체크포인트 복원과 git 되돌리기에 함께 쓰이고 흐름 안에서 동사가 바뀜 | medium | S | CheckpointMenu, GitChanges |
| 62 | Claude/Codex 선택을 '백엔드/Provider/제공자'로 각각 다르게 부름 | medium | S | AutomationForm, WorkerSpawnPage, ForkDialog, CapabilitiesPage |
| 63 | Capability Center 안에서 Library/Catalog, Effective/유효 상태 이름이 서로 다름 | medium | S | CapabilitiesPage, RepositorySettings |
| 64 | Capability 화면에 내부 용어(authoritative, tombstone, desired)가 노출되고 비문도 있음 | medium | S | CapabilitiesPage, i18n capabilities |
| 65 | ko 워커 스폰 화면에 spawn/label/base 영어가 남고 스폰/생성 용어가 섞임 | medium | S | WorkerSpawnPage, Toaster |
| 66 | ko에서 Workflow/워크플로/Phase/Dynamic Workflow가 섞임 | medium | S | WorkspaceHeaders, WorkflowRuns |
| 67 | ContextMenu를 닫아도 포커스가 원래 버튼으로 돌아오지 않음 | medium | S | ContextMenu, useFocusTrap |
| 68 | FileTree의 이름 변경/삭제 등이 우클릭으로만 열림 | medium | S | FileTree |
| 69 | FileTree 검색 결과를 키보드로 탐색하거나 열 수 없음 | medium | S | FileTree |
| 70 | 슬래시/@멘션/이슈 팝업에서 화살표로 고른 항목이 스크롤 밖으로 사라짐 | medium | S | PromptEditor, FileMentionPopup, WorkerSpawnPage |
| 71 | dock 탭 overflow chevron에 포커스도 레이블도 없음 | medium | S | WorkspaceDock |
| 72 | 접고 펴는 버튼 대부분에 aria-expanded가 없음 | medium | S | ToolGroup, ThinkingBlock, ToolBlock, RepoTree, WorkflowRuns |
| 73 | Side conversation drawer가 Esc로 닫히지 않고 포커스 관리가 없음 | medium | S | SideConversationDrawer |
| 74 | 승인/질문 InteractionCard가 나타나도 포커스나 단축키가 없음 | medium | S | InteractionCard |
| 75 | 알림 벨 팝오버를 열어도 포커스가 패널로 이동하지 않음 | medium | S | AttentionBell |
| 76 | 이름 변경 등의 Enter 처리에 IME 조합 가드가 없음 | medium | S | Sessions, RepoTree, FileTree, WorkerSpawnPage |
| 77 | RepoModal·필터·rename input이 placeholder에만 의존하고 레이블이 없음 | medium | S | RepoModal, RepoTree, FileTree, Sessions |
| 78 | 행 액션 버튼의 접근성 이름이 'Delete'/'Edit'뿐이라 어느 항목인지 알 수 없음 | medium | S | AutomationPage, Sessions |
| 79 | Reset layout에 확인·Undo가 없고, 터미널은 닫으면서 사이드바 폭은 그대로 둠 | medium | M | WorkspaceHeaders, WorkspaceDock |
| 80 | 터미널 토글/Ctrl+`가 셸 없이 빈 띠만 열고 탭 줄이 두 겹 | medium | M | TerminalPanel, WorkspaceDock, WorkspaceHeaders |
| 81 | compact 상태에서 바꾼 dock 레이아웃은 저장되지 않음 | medium | M | WorkspaceDock, layout.ts |
| 82 | Cmd/Ctrl+W를 누르면 에디터 탭이 아니라 앱 창이 닫힘 | medium | M | main/index.ts, RookeryTab |
| 83 | 워커 스폰 진입점이 라벨 없는 '+' 하나이고 바로 옆에 휴지통이 항상 보임 | medium | M | RepoTree, App |
| 84 | 워커 브랜치 전체 diff를 볼 방법이 없음(주석은 메뉴로 옮겼다고 함) | medium | M | WorkspaceHeaders, RepoTree |
| 85 | 컴포저 하단 select 4개가 복잡하고 send 버튼이 따로 줄바꿈됨 | medium | M | Composer, SpeedControl |
| 86 | 세 컴포저(대화/New session/New worker)의 모서리·전송 버튼·배치·제출 키가 다름 | medium | M | Composer, WorkerSpawnPage, NewSessionPage |
| 87 | New session/worker 페이지의 입력 카드가 화면 중간에 떠 있고 폴더 선택기가 두 번 나옴 | medium | M | NewSessionPage, WorkerSpawnPage |
| 88 | git 저장소가 아닌 폴더나 git 실패도 '변경 없음'으로 표시됨 | medium | M | GitChanges, GitHistory, CommitView, workspace-manager |
| 89 | repos.list가 실패하거나 늦으면 '등록된 저장소 없음' CTA가 잘못 뜸 | medium | M | App, RepoTree, NewSessionPage |
| 90 | Capability Center가 변경 브로드캐스트가 올 때마다 목록 전체를 스피너로 교체함 | medium | M | CapabilitiesPage, LibraryTab, AssignmentsTab |
| 91 | 폼마다 라벨·섹션 타이포가 다르고 섹션 제목과 필드 라벨이 같은 말을 반복함 | medium | M | SettingsPage, AutomationForm, WorkerSpawnPage |
| 92 | SpeedControl이 라벨 없는 고스트 드롭다운이라 무엇을 고르는 컨트롤인지 알 수 없음 | medium | M | SpeedControl, AutomationForm, SettingsPage |
| 93 | Settings 저장 방식이 셋으로 섞여 있고 Save 버튼은 화면 밖에 있거나 사라짐 | medium | M | SettingsPage |
| 94 | API 키·토큰 저장 시 응답 전에 입력을 비우고 'Saved'로 표시해서 실패해도 되돌아가지 않음 | medium | M | SettingsPage, App |
| 95 | 920 폭 Settings에서 설명문이 좁은 칼럼으로 눌리고 한국어가 음절 단위로 끊김 | medium | M | SettingsPage |
| 96 | 자동화 폼이 Action보다 실행 설정을 먼저 묻는데 그 필드는 Action에 따라 바뀜 | medium | M | AutomationForm |
| 97 | 자동화 행의 'Enabled' 체크박스와 액션 4개가 항상 노출되고 삭제 구분이 약함 | medium | M | AutomationPage |
| 98 | Capability Center Effective 화면의 정보 과밀(0 카운터, 메타 반복, 줄바꿈) | medium | M | CapabilitiesPage, builtins.ts |
| 99 | 탭·세그먼트 활성 표시가 6가지로 다름 | medium | M | dockview-theme.css, CapabilitiesPage, Segment, GitChanges, TerminalPanel |
| 100 | '실행 중' 하늘색(run)이 경고 색으로도 쓰임(warn 토큰 없음) | medium | M | globals.css 외 7+ 파일 |
| 101 | 선택/활성 행 표시가 중립·주황 틴트·주황 텍스트로 제각각 | medium | M | FileTree, CommitView, PromptEditor, App, Sessions |
| 102 | 다이얼로그마다 패딩·그림자·폭이 다르고 미저장 확인창만 별도 구현 | medium | M | confirm-dialog, SettingsPage 외 |
| 103 | 파괴적 작업의 확인 방식이 모달/2단 클릭/확인 없음으로 제각각 | medium | M | CheckpointMenu, CapabilityLibraryTab, SettingsPage, TerminalPanel |
| 104 | 한국어 UI에 미번역 영어 라벨(속도·권한·Capabilities 등)이 섞임 | medium | M | i18n ko, SpeedControl, Composer |
| 105 | i18n을 거치지 않은 하드코딩 문자열(에러 수, input/result, Daemon, off 등) | medium | M | ToolGroup, ToolBlock, StatusBar 외 |
| 106 | 리사이즈 핸들과 dock sash가 키보드로 조작되지 않고 더블클릭 초기화도 없음 | medium | M | ResizeHandle, useResizableWidth, dockview-theme.css |
| 107 | 세션 행 하나에 tab stop이 최대 4개이고 Arrow 탐색과 aria-current가 없음 | medium | M | Sessions, RepoTree, App |
| 108 | 플로팅 인스펙터 카드의 top inset 때문에 탭 스트립 높이가 어긋남 | low | S | dockview-theme.css |
| 109 | 세션 목록과 워커 트리의 hover 강도가 다름 | low | S | Sessions, RepoTree |
| 110 | Settings 컨트롤 폭이 들쭉날쭉하고 Browse 버튼이 입력보다 낮음 | low | S | SettingsPage, Button, Input |
| 111 | 팝오버·메뉴 표면 스타일이 혼재하고 Resource 라벨이 대문자로 하드코딩됨 | low | S | OpenInAppMenu, ContextMenu, AttentionBell 외 |
| 112 | '다시 시도' 버튼이 화면마다 수제 클래스로 구현됨 | low | S | CapabilitiesPage, AutomationPage, Sessions, RepoTree |
| 113 | Capability 대상 카드에서 라벨 문장까지 모노스페이스 | low | S | CapabilitiesPage |
| 114 | 파일 트리 검색이 walk가 끝나기 전에 '일치 항목 없음'을 표시함 | low | S | FileTree |
| 115 | Activity 빈 상태 문구가 '아직…'이고 내부 용어를 씀 | low | S | ActivityPanel, RightSidebar |
| 116 | 전송·새 세션 시작 중에 로딩 표시가 없음 | low | S | Composer |
| 117 | 종료된 워커의 view-only 컴포저에 비활성 컨트롤이 남아 있음 | low | S | Composer, ConversationPane |
| 118 | 세션 목록에는 텍스트 필터가 없음 | low | S | Sessions |
| 119 | 사용량 갱신 주기·Codex 타임아웃을 밀리초로 직접 입력하게 함 | low | S | SettingsPage |
| 120 | 어텐션 벨 무시 버튼이 '묵살'로 번역됨 | low | S | i18n ko attentionBell |
| 121 | Capability·사용량 시각이 앱 언어가 아니라 OS locale로 포맷됨 | low | S | CapabilitiesPage, UsagePanel |
| 122 | ko 카피에서 해요체와 합니다체가 섞이고 반말·잘린 문장이 있음 | low | S | i18n ko (images, speed, settings…) |
| 123 | effort를 '강도'와 'effort'로 섞어 씀 | low | S | SettingsPage, Composer, ForkDialog 외 |
| 124 | 헤더 메트릭(ctx, tok, 종료 사유)에 설명이 없음 | low | S | MetricsView |
| 125 | idle을 '유휴/대기 중/대기 상태'로 섞어 씀 | low | S | StatusBadge, notify, CapabilitiesPage |
| 126 | 제품명이 'rookery'와 'Rookery'로 섞임 | low | S | Onboarding, Settings, WindowControls |
| 127 | ko 카피에서 2인칭 '당신'을 씀 | low | S | AttentionBell, Onboarding |
| 128 | en 보관 섹션 제목 'Archive 3'이 동작 버튼처럼 읽힘 | low | S | Sessions, RepoTree |
| 129 | 오버레이 페이지마다 Escape 동작이 다름 | low | S | SettingsPage, AutomationPage, CapabilitiesPage |
| 130 | 이미지 라이트박스가 aria-modal인데 포커스를 받지 않고 닫기 버튼이 없음 | low | S | MessageImages |
| 131 | 설정 카테고리 레일(role=tab)에 Arrow 키 탐색이 없음 | low | S | SettingsPage |
| 132 | 마우스로 클릭한 뒤에도 Tooltip이 남아 있음 | low | S | Tooltip |
| 133 | FileTree 이름 대화상자: 실패하면 입력이 사라지고 Esc 취소가 안 됨 | low | S | FileTree |
| 134 | 오버레이 페이지 헤더의 패딩과 구성이 페이지마다 다름 | low | M | NewSessionPage, SettingsPage, AutomationPage 외 |
| 135 | 한 행 안에서 아이콘 크기가 섞이고 stroke가 IDE 기준(1.5)과 다름 | low | M | RepoTree, RookeryTab, TerminalPanel 외 |
| 136 | 빈/에러 상태 아이콘 크기가 제각각이고 알림 빈 상태에 이모지가 있음 | low | M | AutomationPage, CapabilitiesPage, AttentionBell 외 |
| 137 | 리소스 모니터 IPC가 실패하면 팝오버가 스켈레톤에 갇힘 | low | M | ResourceMonitor, App |
| 138 | worktree·fleet·transcript·diff 용어가 원문/음차/번역어로 섞임 | low | M | i18n ko |
| 139 | 같은 '레포'를 repo/Repository, 레포/저장소로 섞어 씀 | low | M | i18n en/ko |
| 140 | 전역 단축키가 사실상 Ctrl+` 하나뿐이고 그마저 안내가 없음 | low | M | WorkspaceDock, WorkspaceHeaders, App |

---

## 테마별 상세

### T1. 도크 레이아웃 · 패널 리사이즈

#### #1 대화 패널 최소 폭이 없어 sash를 끌면 한 글자씩 세로로 찌그러짐 — high / S
- **렌즈**: ia-navigation, pixel-pass, layout-resize (3건 병합: `conversation-no-min-width` ×2, `no-min-width-conversation-crush`)
- **증거**: `renderer/workspace/panels.tsx:40-51` (setConstraints는 terminal의 minimumHeight 하나뿐), `:57-64`; `renderer/workspace/WorkspaceDock.tsx:57-66` (addPanel에 minimumWidth 없음); `node_modules/dockview-core/.../dockviewGroupPanel.js:4-5` (기본 최소 100px); shot 11, 12
- **상세**: conversation/inspector 그룹에 minimumWidth가 없어서 dockview 기본값인 100px까지 줄어듭니다. 우측 sash를 왼쪽 끝까지 끌면 대화가 약 30–80px가 되고, 사용자 메시지는 'R e m e m b e r…'처럼 한 글자씩 줄바꿈되고, 컴포저에는 '…'과 chevron만 남습니다. send 버튼은 패널 테두리에 반쯤 가려집니다. 사이드바를 넓혀도 이 상태가 그대로 유지되고(shot 12), 되돌릴 방법은 Reset layout뿐입니다. 높이 방향도 같아서 터미널을 위로 끌면 conversation이 100px로 줄고 메시지 목록이 사라집니다.
- **제안**: TerminalDockPanel처럼 conversation 패널에서 `group.api.setConstraints({ minimumWidth: 360, minimumHeight: 200 })`를 거세요. files/git/nested 그룹에는 minimumWidth 220 정도를 주세요.

#### #3 우측 패널에 최대 폭이 없어 넓은 화면에서 빈 패널이 과하게 넓어지고 에디터를 누름 — high / S
- **렌즈**: pixel-pass (`wide-panels-sparse`)
- **증거**: `renderer/workspace/WorkspaceDock.tsx` seedSize(initialWidth 320만 있고 maximumWidth 없음), `panels.tsx:45`; shot 08, 40
- **상세**: 1920x1080에서 우측 패널이 약 735px를 차지하는데 내용은 파일 한 줄과 커밋 입력란뿐입니다. 대화 칼럼은 720px로 고정되어 있어서 화면 절반이 빈 패널이 됩니다. 한국어 1440 에디터 화면(shot 40)에서는 빈 상태 문구 한 줄만 있는 Activity 패널이 약 600px를 차지하고, 정작 코드 에디터는 약 490px로 눌려 코드가 잘립니다.
- **제안**: 우측 그룹에 기본 최대 폭(360–440px)을 setConstraints로 걸고, 남는 폭은 메인 영역에 주세요.

#### #4 좁은 창에서 우측 패널이 말없이 제거되고 헤더 토글은 '사용자가 끈 것'처럼 보임 — high / M
- **렌즈**: interaction-feedback, ia-navigation, pixel-pass, layout-resize (4건 병합: `compact-autohide-silent`, `compact-dock-silent-hide`, `right-panel-vanishes-narrow`, `compact-silently-removes-right-panel`)
- **증거**: `renderer/App.tsx:377-378`; `renderer/lib/layout-budget.ts:4,23-30`; `renderer/workspace/WorkspaceDock.tsx:96-123`; `renderer/components/WorkspaceHeaders.tsx:107-109,123-129`; `renderer/store/dock-panels.ts`; shot 06, 07, 09, 20, 41
- **상세**: main 폭(viewport − 사이드바)이 720px 미만이면 `applyResponsiveCompact`가 Files/Git/Activity를 통째로 제거하고 `setHidden_`으로 기록합니다. 기본 사이드바(252px)라면 창이 978px 미만일 때부터, 사이드바를 440px로 넓혔다면 1166px 미만일 때부터 이렇게 됩니다. 앱이 강제하는 최소 창 크기 920px에서는 항상 패널이 없습니다. 같은 920px에서 사이드바만 접으면 패널이 다시 나타납니다(shot 06↔09, 실제 앱 CDP로 재현). 헤더 토글은 사용자가 끈 것과 같은 모양이고 '공간이 좁아 숨김'이라는 안내도 없어서, 사용자는 패널을 잃어버렸다고 느낍니다. 토글을 누르면 좁은 공간에 패널이 강제로 열리고, 이때 바뀐 레이아웃은 저장되지 않습니다(#81).
- **제안**: 자동 숨김을 dockPanelsStore의 사용자 hidden과 분리하세요. 토글에는 별도 상태(점선 테두리와 '창이 좁아 숨김 — 클릭해서 열기' tooltip)를 주세요. 그룹을 제거하는 대신 최소 폭으로 접거나 overlay drawer로 전환하는 방식도 검토하세요. compact 판정은 viewport가 아니라 실제 dock 컨테이너 폭(ResizeObserver)으로 바꿔서 사이드바 토글과 엮이지 않게 하세요.

#### #5 좁은 창에 갔다 돌아오면 우측 패널이 320px가 아니라 절반 폭으로 다시 붙고 그대로 저장됨 — high / M
- **렌즈**: ia-navigation, pixel-pass, layout-resize (3건 병합: `compact-restore-width-drift`, `layout-drift-after-resize`, `right-panel-reopen-half-width-drift`)
- **증거**: `renderer/workspace/WorkspaceDock.tsx:50-56` (seedSize는 initialWidth만), `:86-90` (reopen), `:110-120` (복원 후 persist); `dockview-core/.../dockviewComponent.js:2146-2151` (orientation 판정으로 initialWidth/initialHeight 선택); shot 02(기준) vs 10, 35, 36
- **상세**: compact가 풀리면 `reopen()`이 패널을 다시 추가합니다. 이때 terminal이 conversation 아래에 있으면 grid 깊이 판정 때문에 수평 분할이 VERTICAL로 계산되고, `initialWidth:320` 대신 undefined인 initialHeight가 쓰여서 공간이 반반 나뉩니다. 픽셀로 재보면 정상 상태는 우측 패널이 약 333px(24%)인데, 복귀 후에는 약 602px(43%)이고 대화는 866px에서 583px로 줄어듭니다. 컴포저 칩이 두 줄로 줄바꿈되고 placeholder도 잘립니다. 복원 직후 persist가 호출되기 때문에 이 비율이 페이지 레이아웃으로 저장되고, 이후 여러 화면을 거쳐도 남습니다(shot 35). 검증 메모: "terminal이 전체 폭을 차지해서 우측 패널과 겹친다"는 서술은 과장이었습니다. terminal은 여전히 conversation 폭에만 걸쳐 있습니다.
- **제안**: compact로 제거하기 전에 우측 그룹 폭과 `api.toJSON()`을 저장해 두고, 복귀할 때 fromJSON으로 되돌리세요. 최소한 reopen 직후 `group.api.setSize({width: 저장값 ?? 320})`를 호출하세요. 붙이는 위치는 grid 루트 기준의 절대 방향(right)으로 하세요.

#### #6 우측 패널과 터미널 사이에 빈 영역(dead zone)이 생김 — high / M
- **렌즈**: pixel-pass (`dock-dead-zones`)
- **증거**: `renderer/workspace/default-template.ts` (conversation 아래 terminal, 옆에 files/git); shot 03, 05, 08, 09, 10
- **상세**: 터미널이 열려 있으면 우측 패널이 Commit 버튼에서 끝나고, 그 아래로 상태바까지 배경만 있는 빈 사각형이 남습니다(shot 08에서 화면 높이의 약 13%). shot 03에서는 패널이 거의 바닥까지 내려와 있어서, 창 크기와 상태에 따라 모양이 다릅니다. 레이아웃이 덜 만들어진 것처럼 보입니다.
- **제안**: 터미널을 대화 칼럼 아래에만 둘 거라면 우측 패널을 바닥까지 늘리세요. 아니면 터미널이 전체 폭을 쓰게 해서 빈 칸이 생기지 않게 하세요.

#### #7 좁은 창에서 사용자가 숨긴 우측 패널이 창이 넓어지면 다시 열림 — medium / S
- **렌즈**: layout-resize (`compact-toggle-hide-overridden`)
- **증거**: `renderer/workspace/WorkspaceDock.tsx:96-122` (responsiveHiddenRef 기록·복원), `:254-265` (header 토글 reconcile에서 ref를 갱신하지 않음), `:217-219`
- **상세**: 좁은 상태에서 토글로 패널을 열었다가 다시 닫아도 ref에 기록이 남아 있어서, 창이 넓어지면 restore 루프가 패널을 다시 엽니다. 사용자가 명시적으로 내린 숨김 결정이 창 크기 변화 때문에 덮어써집니다. 반대로 좁은 상태에서 연 패널은 ref에 남아 그동안의 레이아웃 저장도 막습니다.
- **제안**: unsubPanels에서 사용자가 show/hide한 kind는 responsiveHiddenRef에서 지우세요.

#### #8 Files/Git 중 하나만 닫아도 우측 토글이 '꺼짐'으로 보이고 클릭 결과가 반대 — medium / S
- **렌즈**: layout-resize (`right-toggle-partial-state`)
- **증거**: `renderer/store/dock-panels.ts:30-33,71-75`; `WorkspaceHeaders.tsx:109,123`; `dockview-theme.css:106-116`
- **상세**: 토글 상태가 `isGroupOpen`(모든 kind가 보일 때만 on)이라서, Git 탭만 ×로 닫으면 Files가 보이는데도 토글은 꺼진 것으로 표시됩니다. 이때 누르면 '전부 보이기'가 실행됩니다. 인스펙터 탭의 ×는 hover할 때 leading icon 자리에 겹쳐 나타나서 실수로 닫기도 쉽습니다.
- **제안**: 하나라도 보이면 on(또는 부분 상태)으로 표시하고 클릭하면 숨기게 하세요. 아니면 인스펙터 탭의 ×를 없애고 그룹 단위로만 열고 닫게 하세요.

#### #9 Side conversation drawer가 viewport 기준 breakpoint로 360px 고정되어 좁은 dock에서 대화를 누름 — medium / S
- **렌즈**: layout-resize (`side-drawer-viewport-breakpoint`)
- **증거**: `renderer/components/SideConversationDrawer.tsx:83` (`absolute inset-0 … md:relative md:w-[360px]`); `ConversationPane.tsx:95-125`; shot 36, 37
- **상세**: overlay와 inline을 viewport 기준 `md:`(768px)로 가르는데 창 최소 폭이 920px이라서 overlay 분기는 실제로 쓰이지 않습니다. 대화 영역이 400–550px일 때 drawer를 열면 본 대화가 40–190px만 남아 #1과 같은 붕괴가 일어납니다.
- **제안**: ConversationPane에 `container-type:inline-size`를 주고, `@container (min-width:760px)`에서만 inline으로, 그보다 좁으면 overlay로 전환하세요.

#### #11 패널 토글이 열림/닫힘 상태를 tooltip·aria-pressed로 알리지 않음 — medium / S
- **렌즈**: copy-i18n, a11y-keyboard (2건 병합: `panel-toggle-tooltips`, `panel-toggles-no-pressed-state`)
- **증거**: `renderer/components/WorkspaceHeaders.tsx:100,113-131`; `App.tsx:1197,1204`; `i18n/locales/ko/workspaceHeaders.ts:4,7,8`; shot 06, 14
- **상세**: 터미널, 오른쪽 패널, 사이드바 토글은 tooltip이 '터미널', '파일·변경·활동'으로 고정되어 있고, on/off는 bg-raised 배경 하나로만 표시됩니다. aria-pressed도 없습니다(같은 저장소의 RepoTree/UsagePanel에는 있습니다). #4처럼 자동으로 숨겨진 상태를 구분할 단서가 없고, Reset layout tooltip에는 터미널까지 닫힌다는 안내가 없습니다.
- **제안**: tooltip을 '터미널 열기/닫기'처럼 상태에 따라 바꾸고 `aria-pressed={open}`을 넣으세요. 자동 숨김 상태라면 그 사실을 tooltip에 덧붙이세요.

#### #12 대화 탭이 단독일 때는 숨었다가 파일을 열면 나타나 본문이 32px 밀림 — medium / S
- **렌즈**: ia-navigation (`conversation-tab-appears-on-demand`)
- **증거**: `renderer/workspace/dockview-theme.css:46-49`; shot 17 vs 19
- **상세**: 대화 패널이 혼자 있으면 CSS가 탭 스트립을 숨깁니다. 첫 파일이나 diff를 열면 탭 스트립이 생기면서 대화 본문 전체가 아래로 밀리고, 처음 보는 'Worker'/'Master' 탭이 나타납니다.
- **제안**: 탭 스트립을 항상 보이게 하거나, 숨길 때도 같은 높이의 빈 스트립을 남기세요.

#### #13 워커 페이지 우측 패널이 대개 비어 있는 Activity 탭으로 시작함 — medium / S
- **렌즈**: ia-navigation (`worker-default-activity-tab`)
- **증거**: `renderer/workspace/default-template.ts:14-24`; `WorkspaceDock.tsx:68-76`; shot 17, 18b
- **상세**: nested(Activity)가 files 그룹에 마지막으로 추가되어 활성 탭이 됩니다. live-only라서 종료된 워커에서는 거의 항상 빈 화면이고, 사용자는 변경 내용을 보려고 매번 Git 탭을 다시 눌러야 합니다.
- **제안**: 시드한 뒤 Git 패널을 활성화하세요. workflow나 nested 활동이 있을 때만 Activity를 앞으로 가져오세요.

#### #14 대화 스크롤바가 720px 칼럼 끝(화면 중간)에 있고, 칼럼 밖 여백에서는 휠 스크롤이 안 됨 — medium / S
- **렌즈**: visual-consistency, pixel-pass, layout-resize (3건 병합: `transcript-scrollbar-midpane`, `worker-transcript-scrollbar-mid`, `transcript-scrollbar-mid-pane`)
- **증거**: `renderer/components/MessageList.tsx:200-202` (`mx-auto max-w-[720px] overflow-y-auto`가 같은 요소에 있음); shot 17, 18, 18b
- **상세**: 스크롤 컨테이너 자체가 720px 칼럼이라서 스크롤바가 대화와 우측 패널 사이 허공(x≈1468)에 떠 있습니다. 칼럼 밖 좌우 여백에서는 휠이 먹히지 않고, 패널이 넓을수록 이 죽은 영역도 커집니다. 맨 위 메시지는 페이드 없이 반쯤 잘려 보입니다.
- **제안**: 바깥 div를 `w-full overflow-y-auto` 스크롤러로 만들고, 그 안에 `mx-auto max-w-[720px]` 래퍼를 두세요. 상단에는 페이드 마스크를 고려하세요.

#### #79 Reset layout에 확인·Undo가 없고, 터미널은 닫으면서 사이드바 폭은 그대로 둠 — medium / M
- **렌즈**: interaction-feedback, pixel-pass, layout-resize (3건 병합: `reset-layout-no-feedback`, `reset-layout-closes-terminal`, `reset-layout-scope-surprises`)
- **증거**: `renderer/components/WorkspaceHeaders.tsx:126-134`; `renderer/workspace/WorkspaceDock.tsx:68-76` (터미널이 0개면 seed에서 빠짐), `:268-281`; `App.tsx:369-374` (사이드바 폭은 따로 저장); shot 03, 12 → 14
- **상세**: 아이콘 하나로 페이지 dock 레이아웃을 즉시 지우고, 확인이나 Undo는 없습니다(앱에 Toaster와 ConfirmDialog 패턴이 이미 있습니다). seed는 열린 터미널이 0개면 터미널 패널을 다시 만들지 않아서, 열어 둔 빈 터미널 패널이 닫힙니다. 반면 사이드바 폭은 건드리지 않아서 440px로 넓힌 상태가 그대로 남습니다. 레이아웃이 꼬였을 때 유일한 복구 수단인데, 무엇이 초기화되는지 예측할 수 없습니다. 검증 메모: "아이콘에 라벨이 없다"는 부분은 과장이었습니다. 다른 헤더 버튼처럼 title tooltip이 있습니다.
- **제안**: 초기화 직전 레이아웃을 보관해 두고 '레이아웃 초기화 · 실행 취소' toast를 띄우세요. 터미널을 열어 둔 상태였다면 그대로 유지하세요. tooltip은 '이 페이지의 패널 배치 초기화'처럼 범위가 드러나게 바꾸고, 사이드바 폭 포함 여부는 하나로 정하세요.

#### #80 터미널 토글/Ctrl+`가 셸 없이 빈 띠만 열고 탭 줄이 두 겹 — medium / M
- **렌즈**: interaction-feedback, ia-navigation, pixel-pass, layout-resize, ux-complexity (5건 병합: `terminal-toggle-empty`, `terminal-toggle-empty-strip`, `terminal-empty-placeholder`, `terminal-open-empty-strip`, `terminal-two-step-open`)
- **증거**: `renderer/components/TerminalPanel.tsx:28-34,42-55,59-72`; `renderer/workspace/WorkspaceDock.tsx:300-310` (Ctrl+`는 `toggle_`만 호출); `App.tsx:436` (비dock 경로에는 이미 자동 spawn이 있음); `i18n/en/terminalPanel.ts:6-7`; shot 03, 04, 05, 06, 08
- **상세**: 기본값인 dock 모드에서 토글이나 Ctrl+`는 패널 표시만 바꿉니다. 터미널이 0개인 페이지에서는 '+ New terminal' 버튼과 'Press + to open a terminal…' 힌트만 있는 띠가 열리고, 셸을 쓰려면 한 번 더 눌러야 합니다. 비dock 경로는 같은 문제를 이미 고쳐 두었는데(주석: "skip the empty-drawer + + step") dock 모드에는 반영되지 않았습니다. 셸을 열면 dockview 'Terminal' 탭 아래에 TerminalPanel 자체 탭 줄이 또 생겨 탭이 두 단이 됩니다. newTab에는 in-flight 가드가 없어서 두 번 누르면 셸이 두 개 생기고, 탭의 X는 실행 중인 프로세스를 확인 없이 kill합니다.
- **제안**: 터미널이 0개인 상태에서 토글이나 Ctrl+`로 열면 `newTab()`을 자동으로 호출하세요. 셸이 1개뿐이면 내부 탭 줄을 숨기고 '+'를 dockview 그룹 header actions로 옮기세요. newTab에는 creating 가드를 넣으세요.

#### #81 compact 상태에서 바꾼 dock 레이아웃은 저장되지 않음 — medium / M
- **렌즈**: layout-resize (`narrow-layout-changes-not-saved`)
- **증거**: `renderer/workspace/WorkspaceDock.tsx:217-219, :290-296` (responsiveHidden이 비어 있을 때만 persist/flush), `:271-274`
- **상세**: 920–1160px 창에서 터미널 높이를 조절하거나 패널을 옮겨도, 다른 세션으로 이동하거나 재시작하면 모두 사라집니다. 이 기간에 저장본이 없는 페이지에서는 Reset layout도 아무 반응이 없습니다. 노트북에서는 흔한 폭입니다.
- **제안**: 자동으로 제거된 우측 그룹을 다시 끼워 넣은 형태로 직렬화하세요. 최소한 우측 그룹 외의 변경은 저장되게 하세요. Reset은 저장본 유무와 상관없이 항상 다시 seed하세요.

#### #108 플로팅 인스펙터 카드의 top inset 때문에 탭 스트립 높이가 어긋남 — low / S
- **렌즈**: visual-consistency (`inspector-tabstrip-misaligned`)
- **증거**: `renderer/workspace/dockview-theme.css:33-39` (32px로 맞추려는 의도), `:83-96` (padding 8px 12px 12px 4px + border); shot 19, 40
- **상세**: 인스펙터 탭 라벨이 메인 에디터 탭보다 약 10px 아래에 있어서 탭 레일이 계단처럼 보입니다. "strips line up"이라는 주석의 의도와 다릅니다.
- **제안**: 인스펙터 카드의 top inset을 0으로 하세요. 아니면 메인 그룹 헤더에도 같은 offset을 주세요.

### T2. 에디터 탭 · 에디터

#### #2 창을 줄이면 활성 에디터 탭이 overflow chevron 안으로 숨고 라벨이 잘림 — high / S
- **렌즈**: visual-consistency, ia-navigation, pixel-pass, layout-resize (4건 병합: `editor-tab-spacing-clip`, `tab-overflow-active-hidden`, `active-tab-hidden-in-overflow` ×2)
- **증거**: `renderer/workspace/dockview-theme.css:44-56, :94-102` (축소 규칙이 인스펙터 그룹에만 있음); `renderer/workspace/RookeryTab.tsx:90-104`; `dockview-core/.../tabs.js:432-455` (활성화할 때만 scroll 보정); shot 19, 20, 34, 40, 41
- **상세**: 1440에서 changelog.js가 활성인 상태로 920으로 줄이면 탭 줄에는 Worker/package.json/README.md/releases.json만 보이고, 편집 중인 파일은 '⌄ 2' 안에 숨습니다. 헤더 breadcrumb은 워커 이름만 보여 주고, Files 트리도 자동으로 숨겨진 상태라서 지금 어떤 파일을 보고 있는지 화면 어디서도 알 수 없습니다. 에디터 탭에는 `min-width:0`/`overflow:hidden`이 없어서 'relea'처럼 말줄임표 없이 글자 중간에서 잘리고, 탭이 라벨보다 넓게 잡혀 일찍 넘칩니다. 검증 메모: "에디터 탭끼리 간격이 제각각"이라는 주장은 픽셀로 재보니 사실이 아니었습니다. 에디터 탭 간격은 균일하고, Worker 탭만 kind별 padding이 다릅니다.
- **제안**: 에디터 그룹 탭에 `flex:0 0 auto; width:auto; max-width:200px; min-width:0`을 주고 탭 shell에 `overflow:hidden`을 주세요. `onDidLayoutChange`나 ResizeObserver에서 활성 탭을 `scrollIntoView({inline:'nearest'})`하세요. overflow 드롭다운에서는 활성 파일을 체크 표시로 구분하세요.

#### #15 dock 모드 에디터 탭에 '저장 안 됨' 표시가 없음 — medium / S
- **렌즈**: ia-navigation, a11y-keyboard (2건 병합: `dock-tab-no-dirty-dot`, `dock-tab-no-dirty-indicator`)
- **증거**: `renderer/workspace/RookeryTab.tsx:59-66` (dirty 계산), `:90-104` (렌더에는 쓰지 않음) vs `renderer/components/TabBar.tsx:63-71` (레거시는 dot 표시); `renderer/lib/flags.ts:4-6`(dock 기본 ON); shot 19
- **상세**: 기본 ON인 dockview 탭은 dirty 값을 닫기 확인에만 씁니다. 저장 안 한 탭이 있는지는 닫으려고 할 때 확인 대화상자가 떠야 알 수 있습니다. 닫기 X도 hover할 때만 보입니다.
- **제안**: dirty면 라벨 옆이나 X 자리에 점을 항상 보이게 하고, hover하면 X로 바뀌게 하세요(VS Code 방식). aria-label에는 '(저장 안 됨)'을 덧붙이세요.

#### #16 에디터 탭 활성 표시가 거의 없고 탭 폭이 과함 — medium / S
- **렌즈**: pixel-pass (`editor-tabs-no-active-style`)
- **증거**: `renderer/components/TabBar.tsx` (활성 bg-ink와 비활성 bg-sunk가 globals.css에서 같은 oklch(17% 0 0)); 비교 `dockview-theme.css` (활성에 --color-raised 사용); shot 19, 40
- **상세**: 활성 탭과 비활성 탭의 배경 토큰이 같은 색이라 실제로는 구분되지 않습니다. 짧은 파일명에도 탭이 160–220px를 차지하고, 탭 줄과 에디터 사이에 경계도 없습니다.
- **제안**: 탭 폭을 내용에 맞추고, 활성 탭에 에디터와 이어지는 배경과 인디케이터를 주세요.

#### #17 파일을 못 열었거나 용량을 넘은 상태에서도 빈 Monaco가 편집·저장 가능함(파일을 덮어쓸 수 있음) — medium / S
- **렌즈**: state-coverage (`editor-error-state-still-editable`)
- **증거**: `renderer/components/MonacoEditor.tsx:31-33` (value ""로 생성), `:41` (catch → banner만 띄움), `:45` (tooLarge → return), `:53-58` (save는 readOnly만 확인)
- **상세**: 읽기에 실패하거나 tooLarge일 때 배너만 뜨고 에디터는 편집 가능한 상태로 남습니다. 빈 버퍼에 타이핑하고 Cmd+S를 누르면 실제 파일에 씁니다. 너무 커서 못 연 파일을 몇 글자로 덮어쓸 수 있는 데이터 손실 경로입니다. 로딩 중에 입력한 내용은 응답이 오면 조용히 사라집니다.
- **제안**: error/toolarge 상태이거나 첫 read가 끝나기 전에는 `readOnly:true`를 거세요. save는 loaded 플래그를 확인하게 하세요.

#### #18 Diff 탭에 로딩·에러·변경 없음 상태가 없음 — medium / S
- **렌즈**: state-coverage (`monaco-diff-no-loading-error-empty`)
- **증거**: `renderer/components/MonacoDiff.tsx:12-20, :25-31` (then만 있고 catch 없음), `:40`
- **상세**: 응답이 오기 전에는 빈 회색 판만 보이고, 실패하면 그 상태가 그대로 남습니다. HEAD와 작업본이 같은 파일이면 좌우에 똑같은 코드만 보입니다. 로딩 중인지, 실패했는지, 차이가 없는지 구분할 수 없습니다.
- **제안**: loading/error/identical 상태를 두고 스켈레톤, 재시도, '변경 없음' 안내를 겹쳐 보여 주세요.

### T3. 사이드바 · 헤더 · 내비게이션

#### #10 사이드바 폭이 240px 미만이면 뒤로/앞으로 버튼이 사라지고 단축키도 없음 — medium / S
- **렌즈**: layout-resize (`compact-sidebar-loses-back-forward`)
- **증거**: `renderer/App.tsx:1184-1196`; `renderer/lib/layout-budget.ts:5,15-17`; shot 02, 15 vs 14
- **상세**: 사이드바를 최소 근처로 쓰면 back/forward가 사라집니다. Cmd+[ / Cmd+]나 마우스 back 버튼 같은 대체 수단도 없습니다.
- **제안**: back/forward 버튼은 폭과 상관없이 유지하세요. Cmd+[ / ]와 app-command(마우스 back/forward)도 추가하세요.

#### #19 접힌 사이드바 레일이 상태바 아이콘만 반복하고 세션/레포 내비가 없음 — medium / S
- **렌즈**: visual-consistency, ia-navigation, pixel-pass, layout-resize, ux-complexity (5건 병합: `collapsed-rail-duplicates-statusbar` ×3, `collapsed-rail-no-nav`, `collapsed-rail-duplicates-statusbar-no-nav`)
- **증거**: `renderer/App.tsx:1199-1265` (레일 구성); `renderer/components/StatusBar.tsx:39-97` (같은 항목); shot 05, 09
- **상세**: 접힌 레일에는 펼치기, back/forward, ResourceMonitor(이유 없이 강조된 박스), 알림 토글, 데몬 재시작, AttentionBell, Capability, Automation, Settings가 있습니다. 이 중 6개는 항상 보이는 상태바에 똑같이 있습니다. StatusBar 주석은 "사이드바 footer를 치우려고" 상태바를 만들었다고 하는데, 접힌 레일이 그 항목들을 되살려 놓았습니다. 반대로 레일의 본래 역할인 Sessions/Repos 전환과 New session은 없어서, 세션을 바꾸려면 사이드바를 다시 펼쳐야 합니다(`MessageSquare`/`FolderGit2`는 이미 import되어 있습니다).
- **제안**: 레일에는 펼치기, Sessions, Repos(활성 표시와 미읽음 점 포함), New session(+)만 남기고, 상태바와 겹치는 아이콘은 빼세요. AttentionBell은 하나만 두세요.

#### #20 비슷한 아이콘이 서로 다른 기능에 쓰임: 벨 2종, RotateCcw 3종 — medium / S
- **렌즈**: interaction-feedback, ia-navigation, a11y-keyboard, pixel-pass, layout-resize, ux-complexity (7건 병합: `two-bell-icons` ×2, `two-bells`, `two-bells-and-rotate-icons`, `rotateccw-icon-collision`, `reset-layout-icon-collides-restart`, `rotateccw-triple-meaning`)
- **증거**: `renderer/App.tsx:1197, 1232-1242` (레일에서 BellRing → RotateCcw → Bell 순서); `renderer/components/StatusBar.tsx:66-73, 84-91`; `renderer/components/AttentionBell.tsx:143` (Bell, title 없음); `renderer/components/WorkspaceHeaders.tsx:127-134` (Reset layout = RotateCcw); `renderer/components/GitChanges.tsx:116` (git Revert = RotateCcw); shot 01, 02, 05, 17, 30
- **상세**: 어텐션 큐(Bell)와 OS 알림 on/off(BellRing/BellOff)가 모두 종 모양이고, 접힌 레일에서는 재시작 아이콘 하나를 사이에 두고 세로로 놓입니다. AttentionBell에는 title도 없어서 hover로도 구분이 안 됩니다. 같은 알림 토글인데 tooltip 문구가 레일에서는 동작형, 상태바에서는 상태형입니다. RotateCcw는 헤더의 Reset layout(가벼운 동작이지만 확인 없음), 상태바/레일의 Restart daemon(모든 스트림 영향, 확인 있음), git 파일 Revert에 함께 쓰입니다. 검증 메모: 헤더와 상태바가 화면에서 떨어져 있고 데몬 재시작에는 확인창이 있어서 실제 오조작 피해는 제한적입니다. 체크포인트 'Revert'는 History 아이콘이라 RotateCcw 혼동과는 무관합니다.
- **제안**: Reset layout은 LayoutTemplate/PanelsTopLeft, Restart daemon은 Power 계열, git Revert는 Undo2로 나누세요. 알림 토글은 벨이 아닌 아이콘을 쓰거나 Settings/벨 팝오버 안으로 옮기세요. AttentionBell에는 title을 붙이세요.

#### #21 좁은 폭에서 헤더의 Revert·백그라운드 Stop·metrics가 대체 경로 없이 사라짐 — medium / S
- **렌즈**: ia-navigation, pixel-pass, layout-resize, ux-complexity (4건 병합: `header-controls-hidden-narrow`, `header-actions-drop-at-narrow`, `header-controls-vanish-no-overflow`, `header-hides-revert-keeps-reset`)
- **증거**: `renderer/globals.css:267-288` (@container 720px/520px); `renderer/components/WorkspaceHeaders.tsx:41-90, 158-182`; `views/RepoTree.tsx:318-330` (메뉴에 checkpoint 없음); shot 17/19 vs 20, 40 vs 41, 06, 07, 34
- **상세**: 헤더 폭이 720px 이하가 되면(사이드바를 연 920px 창) metrics, checkpoint(Revert), 백그라운드 태스크 Stop 메뉴, ticket, repo breadcrumb가 `display:none`이 됩니다. Revert와 태스크별 Stop은 다른 진입점이 없는 기능 컨트롤인데 overflow 메뉴 없이 사라집니다. 반대로 덜 중요한 Reset layout과 Open in은 끝까지 남습니다. ctx% 같은 context 압박 지표도 볼 수 없습니다.
- **제안**: 숨겨지는 항목을 헤더 오른쪽 '…' overflow 메뉴로 모으세요. 최소한 ctx%는 짧은 형태로 남기고, 숨기는 순서를 Reset layout → Open in → Revert로 바꾸세요.

#### #22 세션 헤더와 워커 헤더의 오른쪽 컨트롤 순서가 반대 — medium / S
- **렌즈**: visual-consistency, ia-navigation, ux-complexity (3건 병합: `header-controls-order`, `header-control-order-inconsistent`, `header-order-inconsistent`)
- **증거**: `renderer/components/WorkspaceHeaders.tsx:173-179` (worker: metrics → checkpoint → controls, gap-1) vs `:214-219` (session: controls → metrics, gap-2.5); shot 02 vs 17
- **상세**: 세션과 워커를 오가면 패널 토글 위치가 x≈1607에서 x≈1915로 움직여서 손에 익지 않습니다. 메트릭 묶음의 위치도 좌우로 바뀝니다.
- **제안**: 두 헤더 모두 'metrics → (워커만) checkpoint → Open in → 터미널 → 패널' 순서와 같은 gap으로 맞춰서, 레이아웃 토글이 항상 맨 오른쪽에 오게 하세요.

#### #23 Repos 메인 영역이 헤더도 액션도 없는 빈 화면 — medium / S
- **렌즈**: pixel-pass (`repos-empty-main-void`)
- **증거**: `renderer/App.tsx` (emptyRepoHint 분기, ~1500); shot 16
- **상세**: 워커를 고르지 않으면 헤더 없는 빈 화면 가운데 회색 3줄 안내만 있고, '+ button on a repo header'처럼 말로만 설명합니다. 자체 디자인 스킬은 빈 상태에 "13px muted 한 줄 + 텍스트 버튼 하나"를 요구합니다.
- **제안**: Repos 헤더를 유지하고, 'New worker' 버튼 같은 바로 실행할 수 있는 액션을 두세요.

#### #24 'Open in ▾'에서 텍스트를 누르면 메뉴가 열리고, 실제로 여는 쪽은 라벨 없는 아이콘 — medium / S
- **렌즈**: ux-complexity (`open-in-split-button`)
- **증거**: `renderer/components/OpenInAppMenu.tsx:39-40, 115-135`; `i18n/en/openInAppMenu.ts:3`; shot 02, 17
- **상세**: 사용자는 동사가 적힌 'Open in' 텍스트를 누르기 쉬운데 그쪽은 메뉴를 열고, 실제 실행은 앱 아이콘이 맡습니다. 아이콘만으로는 어느 앱으로 열리는지 알기 어렵습니다.
- **제안**: 왼쪽을 '[아이콘] Open in IntelliJ'처럼 앱 이름이 들어간 버튼으로 하고, 오른쪽은 ▾만 남기세요.

#### #25 상태바 사용량 수치가 클릭·tooltip이 없어 상세 패널에 갈 수 없음 — medium / S
- **렌즈**: interaction-feedback (`statusbar-usage-dead`)
- **증거**: `renderer/components/StatusBar.tsx:39-62`; `renderer/components/UsagePanel.tsx:73-97, 111-149` (sidebar variant는 아무도 호출하지 않음); shot 34
- **상세**: 사용량 수치는 일반 span이고, 리셋 시점이나 집계 설명이 담긴 상세 패널은 어디서도 열 수 없습니다. 반대로 Slack/Daemon 항목은 버튼이 아닌데 hover 스타일이 있어서 눌러지는 것처럼 보입니다.
- **제안**: ResourceMonitor처럼 사용량 strip을 버튼으로 만들고 sidebar variant를 popover로 띄우세요. Slack 항목은 Settings > Slack으로 연결하거나 hover 스타일을 없애세요.

#### #26 ContextMenu가 viewport 경계를 고려하지 않아 아래·오른쪽 끝에서 잘림 — medium / S
- **렌즈**: interaction-feedback (`context-menu-no-clamp`)
- **증거**: `renderer/components/ContextMenu.tsx:33-40`; `views/RepoTree.tsx:156, 302-316`
- **상세**: 워커 메뉴는 hint가 붙은 항목이 5개라 키가 큰데, 920x600 창에서 아래쪽 행을 우클릭하면 맨 아래 'Delete…'가 화면 밖으로 나가 누를 수 없습니다.
- **제안**: mount한 뒤 `getBoundingClientRect`로 재서 넘치면 위나 왼쪽으로 뒤집어 배치하세요.

#### #27 Resources 팝오버가 페이지를 이동해도 닫히지 않고 폼을 가림 — medium / S
- **렌즈**: pixel-pass (`resources-popover-persists`)
- **증거**: `renderer/components/ResourceMonitor.tsx` (Esc와 오버레이 클릭으로만 닫힘); shot 31 → 32 → 33
- **상세**: New worker에서 연 팝오버가 New automation으로 이동하고 920으로 리사이즈한 뒤에도 남아서 Cost budget과 Action 필드를 가립니다. 키보드나 포커스로 이동하면 오버레이를 거치지 않고 넘어가기 때문입니다.
- **제안**: 라우트나 창 크기가 바뀌면 팝오버를 닫으세요.

#### #83 워커 스폰 진입점이 라벨 없는 '+' 하나이고 바로 옆에 휴지통이 항상 보임 — medium / M
- **렌즈**: ia-navigation, pixel-pass, ux-complexity (3건 병합: `no-new-worker-entry`, `repo-row-always-visible-actions`, `repos-spawn-discoverability`)
- **증거**: `renderer/views/RepoTree.tsx:230-260` (+ / Settings2 / Trash2가 같은 크기로 상시 노출), `:306-311` (New repo); `App.tsx:1266-1275`; `renderer/lib/status.ts:8-11`; `i18n/en/repoTree.ts:7`; shot 16, 17, 29 vs 01, 42
- **상세**: Sessions 뷰에는 '+ New session' 행이 있지만 Repos 뷰에서 워커를 만드는 방법은 레포 헤더의 작은 '+'뿐이고, 그 옆에 설정과 'Unregister' 휴지통이 hover와 상관없이 항상 보입니다. 하단 '+ New repo'가 더 눈에 띄어서 잘못 누르기 쉽고, 빈 상태 안내문이 "+ 버튼을 쓰라"고 길게 설명해야 할 정도입니다. 새 워커 페이지에는 닫기(X)가 있는데 새 세션 페이지에는 없습니다. 워커 행의 'STOP' 태그는 색 없는 회색입니다(#59 참고). 검증 메모: 레포 삭제는 ConfirmDialog를 거치고 디스크 파일도 남기 때문에 "잘못 누르면 손실"이라는 주장은 과장입니다.
- **제안**: 각 레포 그룹 맨 아래나 nav 아래에 '+ New worker' 행을 두세요. 휴지통은 레포 설정이나 우클릭 메뉴로 옮기고, 행 액션은 hover/focus 때만 보이게 하세요. 두 생성 페이지의 헤더(닫기 버튼)를 통일하고, nav 라벨을 'Workers'로 바꾸는 것도 고려하세요.

#### #84 워커 브랜치 전체 diff를 볼 방법이 없음(주석은 메뉴로 옮겼다고 함) — medium / M
- **렌즈**: ia-navigation (`no-aggregate-worker-diff`)
- **증거**: `renderer/components/WorkspaceHeaders.tsx:173`; `views/RepoTree.tsx:313-330`; `src/protocol/messages.ts:324,548` (fleet.diff가 있지만 renderer에서 쓰지 않음); shot 17
- **상세**: 워커가 커밋하고 끝나면 Git Changes는 비어 있어서, 무엇이 바뀌었는지 보려면 History에서 커밋을 하나씩 열어야 합니다. WorkerHeader 주석은 view-diff를 RepoTree 메뉴로 옮겼다고 하지만 실제 메뉴에는 없습니다.
- **제안**: 워커 메뉴와 Git 패널에 'View branch diff'를 추가해서 fleet.diff 결과를 읽기 전용 diff 탭으로 여세요. 잘못된 주석도 고치세요.

#### #118 세션 목록에는 텍스트 필터가 없음 — low / S
- **렌즈**: ia-navigation (`sessions-no-search`)
- **증거**: `views/RepoTree.tsx:274-282` vs `views/Sessions.tsx:205-225, 326-347`
- **상세**: RepoTree는 live 워커가 4개를 넘으면 검색과 'only active' 필터를 보여 주는데, Sessions는 소스 세그먼트만 있습니다.
- **제안**: 세션이 일정 수를 넘으면 RepoTree와 같은 스타일의 검색 입력을 보여 주세요.

### T4. 컴포저 · 대화 · 생성 페이지

#### #28 컴포저 placeholder가 단축키 안내 3개를 담아 길고 잘림 — medium / S
- **렌즈**: copy-i18n, pixel-pass, ux-complexity (3건 병합: `composer-placeholder-truncated`, `placeholder-too-long`, `composer-placeholder-long`)
- **증거**: `i18n/ko/app.ts:35`, `i18n/en/app.ts:34-35`, `i18n/en/composer.ts:3`; `App.tsx:1120,1568`; `PromptEditor.tsx:396`; shot 09, 10, 14, 36, 37
- **상세**: 'Type a message… (/ commands, Shift+Enter for newline, @ to attach files)'는 1440 기본 레이아웃에서만 다 보이고, 그 외에는 '@ to attac…'로 잘립니다. 입력을 시작하면 사라지니 정작 필요할 때는 볼 수 없습니다. 검증 메모: `composer.placeholder` 기본값은 모든 호출부에서 override되어 실제로는 쓰이지 않습니다.
- **제안**: 'Ask anything — @ files, / commands' 정도로 줄이고, Shift+Enter 안내는 빼거나 하단 힌트로 옮기세요.

#### #29 컴포저 아이콘 버튼(따로 질문·첨부·전송)에 tooltip이 없고, Side question은 이름이 세 개 — medium / S
- **렌즈**: interaction-feedback, ia-navigation, a11y-keyboard, ux-complexity (4건 병합: `icon-buttons-missing-tooltip`, `side-question-button-hidden`, `composer-icon-buttons-no-tooltip`, `ask-separately-naming`)
- **증거**: `renderer/components/Composer.tsx:378-387, 405-416` (aria-label만 있음) vs `:396-401` (Stop/Recover에는 title 있음); `i18n/en/composer.ts:20` ('Ask separately'), `i18n/en/sideConversation.ts:3` ('Side question'); `src/core/capabilities/commands.ts:35-68` (/btw, /side 설명이 같음); shot 02, 36
- **상세**: MessageCircleQuestion, Paperclip, Send 버튼은 hover해도 아무 힌트가 없습니다. '?' 아이콘은 도움말처럼 보이고, 입력 전에는 disabled + `pointer-events-none`이라 hover조차 되지 않습니다(#33). 같은 기능이 버튼에서는 'Ask separately', drawer에서는 'Side question', 명령으로는 /btw와 /side 두 개로 노출되어 발견하기 어렵습니다.
- **제안**: 세 버튼을 StatusBar와 같은 Tooltip으로 감싸세요. 이름은 'Side question' 하나로 통일하고 tooltip에 '메인 작업을 멈추지 않고 따로 묻기 (/side)'를 쓰세요. /btw는 alias로만 두세요. disabled 상태에서도 tooltip이 보이게 래핑하세요.

#### #30 전송 대기/실패 버블(12px)과 확정 버블(14px)의 글자 크기가 달라 echo 순간 튐 — medium / S
- **렌즈**: visual-consistency (`pending-bubble-size-jump`)
- **증거**: `renderer/components/MessageList.tsx:115` (text-prose), `:244` (text-ui); `ConversationPane.tsx:102`
- **상세**: 대기 버블(dashed, opacity-70)과 실패 버블은 12px이고 확정 버블은 14px이라서, 전송할 때마다 레이아웃이 튑니다.
- **제안**: 세 버블 모두 text-prose와 같은 패딩·radius를 쓰고, 상태는 테두리, 투명도, 배지로만 구분하세요.

#### #31 전송 직후 'Queued' 버블이 입력창 아래에 렌더링됨 — medium / S
- **렌즈**: interaction-feedback (`pending-bubble-below-composer`)
- **증거**: `renderer/components/ConversationPane.tsx:99-109` (pending 블록이 `<Conversation>` 뒤); `views/Conversation.tsx:28-37`; `App.tsx:761-766, 812-816`
- **상세**: 낙관적 메시지가 컴포저 아래에 나타나서 컴포저를 밀어 올리고, echo가 오면 transcript 안으로 점프합니다. idle 상태에서 보낸 일반 전송도 Clock 아이콘이 붙은 'Queued'로 표시되어 상태가 사실과 다릅니다.
- **제안**: pending 목록을 MessageList 스크롤 컨테이너 안 마지막 행으로 옮기세요. 배지는 busy일 때만 'Queued', 그 외에는 'Sending…'으로 하세요.

#### #32 전송 실패 시 toast와 이미지용 인라인 에러가 동시에 뜸 — medium / S
- **렌즈**: interaction-feedback (`send-double-error-feedback`)
- **증거**: `renderer/App.tsx:774-778, 1405-1411`; `Composer.tsx:224`; `AutomationForm.tsx:177,223`
- **상세**: 같은 실패가 toast와 입력창 위 인라인 문구(`images.sendFailed` 키)로 두 번 보고됩니다. 텍스트만 보냈을 때도 이미지 네임스페이스 키를 씁니다. AutomationForm 저장 실패도 같은 패턴입니다.
- **제안**: 맥락이 있는 폼은 인라인만, 전역 작업은 toast만 쓰도록 정하세요. Composer 문구는 `composer.sendFailed` 키로 분리하세요.

#### #33 비활성 버튼이 이유를 알리지 않음(pointer-events-none 때문에 tooltip도 막힘) — medium / S
- **렌즈**: interaction-feedback (`disabled-buttons-no-reason`)
- **증거**: `renderer/ui/button.tsx:7` (`disabled:pointer-events-none`); `Composer.tsx:380,412`; `GitChanges.tsx:148,217`; shot 36
- **상세**: Composer 전송, side question, Git Commit/Push가 왜 비활성인지 알려 주지 않습니다. side question 버튼은 입력이 비어 있으면 눌러도 반응이 없습니다(shot 36에서도 drawer가 열리지 않았습니다).
- **제안**: `cursor-not-allowed`와 `aria-disabled`로 바꾸고, 비활성 사유를 title로 보여 주세요.

#### #34 Recover(하드킬) 버튼에 진행 상태와 중복 클릭 방지가 없음 — medium / S
- **렌즈**: interaction-feedback (`recover-no-inflight`)
- **증거**: `renderer/components/Composer.tsx:177-180, 392-397`; `App.tsx:854`
- **상세**: Stop은 stopping 스피너를 보여 주지만, 그 다음에 나오는 Recover는 결과를 기다리지 않는 요청이라 눌러도 아무 변화가 없습니다. recover는 멱등이라 중복 클릭 피해는 제한적이지만, 이미 불안한 '멈춘 워커' 상황에서 반응이 보이지 않습니다.
- **제안**: onRecover가 Promise를 반환하게 하고 Button loading을 쓰세요. 성공하면 info toast를 띄우세요.

#### #35 슬래시 명령 목록 로드 실패 시 이전 대상의 명령이 남고 '/' 팝업에 빈 상태가 없음 — medium / S
- **렌즈**: state-coverage (`commands-failure-stale-and-silent`)
- **증거**: `renderer/App.tsx:497` (`.catch(() => {})`); `PromptEditor.tsx:170-175`
- **상세**: 대상을 바꾼 직후 요청이 실패하면 다른 provider의 명령(/name·$name)이 그대로 남습니다. 명령이 0개면 '/'를 입력해도 아무 반응이 없습니다.
- **제안**: 요청을 시작할 때나 실패했을 때 `setCommands([])`로 비우고, '/'에 결과가 없으면 '사용 가능한 명령이 없어요' 한 줄을 보여 주세요.

#### #36 스폰 페이지: 티켓 검색 실패가 '결과 없음'으로 보이고 브랜치 선택기는 조용히 사라짐 — medium / S
- **렌즈**: state-coverage (`spawn-search-error-as-no-results`)
- **증거**: `renderer/App.tsx:335, 338-339`; `WorkerSpawnPage.tsx:93-95, 277-278, 380`; shot 29
- **상세**: 토큰 만료나 gh 오류가 '결과 없음'으로 보입니다. repo.branches가 실패하면 base 선택기가 사라지고, 정상 로딩 때도 선택기가 늦게 끼어들어 메타 행이 밀립니다.
- **제안**: 에러를 그대로 전달해서 '검색 실패 — 연동 상태 확인' 행을 보여 주세요. 브랜치 선택기는 로딩 중에 disabled 플레이스홀더로 자리를 잡아 두세요.

#### #37 스폰 페이지 비용 예산에 잘못된 값을 넣으면 경고 없이 무시됨 — medium / S
- **렌즈**: interaction-feedback (`spawn-budget-silent-drop`)
- **증거**: `renderer/components/WorkerSpawnPage.tsx:138-139, 416-420`
- **상세**: 'abc', '-5', '0'은 undefined로 바뀌어 기본값(또는 무제한)이 조용히 적용됩니다. 'More'가 접혀 있으면 입력한 값을 다시 볼 일도 없어서, 사용자가 건 안전장치가 소리 없이 꺼집니다. AutomationForm에도 같은 패턴이 있습니다.
- **제안**: 인라인 오류를 띄우고 spawn을 막으세요. 접힌 'More' 버튼에는 오류 점을 표시하세요.

#### #85 컴포저 하단 select 4개가 복잡하고 send 버튼이 따로 줄바꿈됨 — medium / M
- **렌즈**: pixel-pass, layout-resize, ux-complexity (3건 병합: `composer-wraps-wastefully`, `composer-send-orphan-wrap`, `composer-four-selects`)
- **증거**: `renderer/components/Composer.tsx:304-378` (단일 flex-wrap에 칩과 액션이 함께 있음); `.claude/skills/rookery-ide-ui/SKILL.md` (Composer: "Permission mode lives in the model menu"); shot 02, 06, 07, 09, 10, 14, 35, 36, 37
- **상세**: 'Claude Opus 4.8 / High / Bypass Permissions / Standard (default)'와 오른쪽 아이콘들이 하나의 flex-wrap에 있어서, 대화 폭이 약 620–760px만 되어도 send·attach가 혼자 다음 줄로 밀리고 컴포저가 세 단으로 커집니다. 가장 자주 누르는 send의 위치가 폭에 따라 바뀝니다. 대부분 턴마다 바꾸지 않는 값인데 입력보다 시각적 비중이 크고, 위험한 기본값인 'Bypass Permissions'가 항상 크게 노출됩니다.
- **제안**: 칩 묶음(min-w-0 flex-1)과 액션 묶음(shrink-0 ml-auto)을 분리해서 send를 항상 첫 줄 오른쪽 끝에 고정하세요. 장기적으로는 'Opus 4.8 · High' 텍스트 버튼 하나로 합치고, popover에서 모델/effort/권한/속도를 고르게 하세요(기본값과 다른 값만 바에 표시).

#### #86 세 컴포저(대화/New session/New worker)의 모서리·전송 버튼·배치·제출 키가 다름 — medium / M
- **렌즈**: visual-consistency, pixel-pass, ux-complexity (3건 병합: `composer-variants`, `inconsistent-send-buttons`, `new-session-vs-spawn-inconsistent`)
- **증거**: `renderer/components/Composer.tsx:274, 396-415`; `WorkerSpawnPage.tsx:193-197, 241, 318-371, 377-420`; `NewSessionPage.tsx:28, 200-216`; shot 01, 02, 29
- **상세**: 대화/New session 컴포저는 rounded-lg에 26px 원형 Send(종이비행기)를 쓰고 Enter로 제출합니다. New worker는 rounded-xl에 28px ArrowUp을 쓰고 ⌘/Ctrl+Enter로 제출합니다. 모델/effort는 New session에서는 왼쪽, New worker에서는 오른쪽에 있습니다. 권한 모드는 대화 컴포저에서는 박스 안, New worker에서는 박스 밖이고, 속도는 New worker에서 'More' 안에 숨어 있습니다. 비슷한 '작업 시작' 화면인데 손에 익지 않습니다.
- **제안**: WorkerSpawnPage도 Composer 컨테이너와 전송 버튼을 재사용하세요. [컨텍스트] 왼쪽, [모델·effort] 오른쪽으로 배치를 통일하고, 제출 키도 하나로 맞추세요.

#### #87 New session/worker 페이지의 입력 카드가 화면 중간에 떠 있고 폴더 선택기가 두 번 나옴 — medium / M
- **렌즈**: pixel-pass, ux-complexity (2건 병합: `centered-composer-void`, `new-session-duplicate-folder-picker`)
- **증거**: `NewSessionPage.tsx:173, 211, 220-240`; `WorkerSpawnPage.tsx:217` (justify-center + pb-[12vh]); shot 01, 29, 46, 47
- **상세**: 헤더와 카드 사이에 화면 높이의 35–40%가 비어 있고, 1920에서는 카드가 작게 떠 있습니다. New session에는 컴포저 안 'orbitkit' 폴더 칩(OS 폴더 다이얼로그)과 아래 'Pick a working folder' 행(등록된 레포 빠른 선택)이 같은 라벨과 아이콘으로 두 번 나옵니다. 부가 옵션 행은 카드 밖에 떨어져 있어서 어디에 속하는지 애매합니다.
- **제안**: 카드를 상단 1/3 지점으로 올리세요. 레포 목록은 폴더 칩 드롭다운의 첫 그룹으로 합치세요(레포가 0개일 때 CTA는 유지). 부가 옵션은 카드 안쪽으로 넣으세요.

#### #116 전송·새 세션 시작 중에 로딩 표시가 없음 — low / S
- **렌즈**: interaction-feedback (`composer-send-no-spinner`)
- **증거**: `Composer.tsx:406-416`; `App.tsx:731-757` (3단계 await); `WorkerSpawnPage.tsx:365-372` (여기는 스피너 있음)
- **상세**: startSession은 create→list→send를 차례로 기다리는데, 그동안 버튼이 회색으로만 바뀝니다.
- **제안**: 전송 버튼에 `loading={sending}`을 적용하세요(Button이 이미 지원합니다).

#### #117 종료된 워커의 view-only 컴포저에 비활성 컨트롤이 남아 있음 — low / S
- **렌즈**: interaction-feedback, ux-complexity (2건 병합: `viewonly-composer-dead-controls`, `ended-worker-composer-noise`)
- **증거**: `Composer.tsx:367-388, 405-416`; shot 17, 18b
- **상세**: 'Worker ended — view only'인데 컴포저 박스, 모델과 'Standard (default)' 라벨, 비활성 첨부·전송 버튼이 그대로 있어서 입력할 수 있는 것처럼 보이고, 다음에 할 일(Fork 등)로 이어지는 안내도 없습니다. 검증 메모: 모델 배지는 의도된 정보이고, Slack 읽기 전용 세션도 같은 컴포저를 씁니다.
- **제안**: terminal 상태에서는 한 줄짜리 상태 바('Worker stopped · Claude Haiku 4.5' + Fork 링크)로 바꾸세요.

### T5. Git 패널

#### #38 Git 패널에 'Changes'가 세 번 나오고 파일명·경로가 중복 표시됨 — medium / S
- **렌즈**: visual-consistency, pixel-pass, ux-complexity (3건 병합: `git-changes-double-label`, `git-panel-redundant-labels`, `git-tab-changes-triple`)
- **증거**: `renderer/components/GitChanges.tsx:109-110, 157-165, 212-221`; `i18n/en/gitChanges.ts:12,20-21`; `i18n/en/workspaceHeaders.ts:7` ('Files · Changes · Activity'); `ui/button.tsx`; shot 02, 08, 36
- **상세**: Git 탭 안에 Changes|History pill 세그먼트가 있고, 그 아래에 다시 'Changes 1' 섹션이 있습니다. 토글 tooltip도 'Files · Changes · Activity'라서 'Git'이라는 이름이 어디에도 없습니다. pill 세그먼트는 스킬이 'toy tell'로 꼽는 패턴입니다. 끝에 슬래시가 붙은 untracked 디렉터리는 '.omc  .omc'처럼 이름과 경로가 똑같이 찍힙니다. Commit 버튼은 disabled 배경과 활성 배경이 같아서 구분되지 않습니다.
- **제안**: Changes 탭 안의 섹션 이름을 'Unstaged/Staged'로 바꾸세요. 장기적으로는 VS Code처럼 Changes/Staged/History를 접히는 섹션으로 쌓고 pill을 없애세요. tooltip은 'Files · Git · Activity'로 맞추고, 루트 항목의 중복 경로는 생략하고, disabled 상태를 분명히 표시하세요.

#### #39 Git 섹션 헤더 chevron이 접히지 않는 가짜 어포던스 — medium / S
- **렌즈**: interaction-feedback, a11y-keyboard (2건 병합: `git-section-fake-chevron`, `git-sectionhead-fake-chevron`)
- **증거**: `renderer/components/GitChanges.tsx:118-134` (주석: "static chevron… the list itself isn't toggled"); shot 02
- **상세**: VS Code처럼 보이는 ChevronDown이 있지만 버튼이 아니라서 눌러도 반응이 없습니다. 파일이 많으면 Staged와 Changes를 따로 접을 수도 없습니다.
- **제안**: aria-expanded가 있는 버튼으로 바꿔서 실제로 접히게 하거나, chevron을 없애세요.

#### #40 Git History가 갱신되지 않고 새로고침도 History에 적용되지 않음 — medium / S
- **렌즈**: state-coverage (`git-history-stale-refresh-ignored`)
- **증거**: `GitChanges.tsx:54-73, 152`; `GitHistory.tsx:29-33` (deps가 [root, version]뿐)
- **상세**: Changes는 worktree 커밋을 잡으려고 2.5초마다 폴링하는데 History는 fs watch에만 반응합니다. 그래서 워커나 패널에서 커밋해도 History에 나오지 않습니다. 새로고침 버튼은 changes/info만 다시 불러오고 피드백도 없습니다.
- **제안**: refresh할 때 History에도 key를 넘기고, 탭이 열려 있는 동안은 폴링하거나 HEAD가 바뀌면 다시 불러오세요. 요청 중에는 아이콘을 회전시키세요.

#### #41 Git Push에 진행 표시, 성공 피드백, 중복 실행 방지가 없음 — medium / S
- **렌즈**: interaction-feedback (`git-push-silent`)
- **증거**: `GitChanges.tsx:75-81, 117-119, 148-152`
- **상세**: Push는 busy 동안 비활성만 되고 스피너가 없습니다. 성공하면 ahead 숫자만 조용히 사라집니다. Stage/Unstage 행 버튼은 busy 중에도 눌립니다.
- **제안**: Push에 Button loading과 'Pushed to <upstream>' toast를 넣고, 행 액션은 busy 동안 disabled로 하세요.

#### #88 git 저장소가 아닌 폴더나 git 실패도 '변경 없음'으로 표시됨 — medium / M
- **렌즈**: state-coverage (`git-panel-not-a-repo-looks-empty`)
- **증거**: `main/workspace-manager.ts:273,300,317,344,356` (code≠0이면 [] 반환); `GitChanges.tsx:142,178-179,199-221`; `GitHistory.tsx:35`; `CommitView.tsx:31`
- **상세**: cwd가 git 저장소가 아니거나(홈 폴더로 fallback한 경우 포함) git이 실패해도 브랜치 '—', '변경 사항 없음', '커밋 없음'이 뜨고 커밋 입력창도 그대로 보입니다. 오류가 정상적인 빈 상태처럼 보입니다.
- **제안**: gitInfo가 `{isRepo:false}`처럼 저장소 여부를 구분해서 돌려주게 하세요. 그 경우 커밋 박스를 숨기고 '이 폴더는 git 저장소가 아니에요'를 보여 주세요. 실패와 빈 결과는 다른 값으로 돌려주세요.

### T6. 로딩 · 에러 · 빈 상태

#### #42 Sessions·Repos 사이드바가 로딩 중 완전히 비어 있음 — medium / S
- **렌즈**: state-coverage (`sidebar-lists-blank-while-loading`)
- **증거**: `views/Sessions.tsx:350-357`; `views/RepoTree.tsx:284-291`; 비교 `AutomationPage.tsx:120-128`
- **상세**: `!loaded && !loadFailed` 분기가 없어서, 연결 직후에는 사이드바가 비어 있다가 목록이 한꺼번에 튀어나옵니다. 다른 패널은 SkeletonRows를 씁니다.
- **제안**: 이 분기에 `<SkeletonRows rows={4} />`를 넣으세요.

#### #43 앱 시작 시 마지막 세션을 복원하기 전에 New Session 화면이 잠깐 보임 — medium / S
- **렌즈**: state-coverage (`cold-start-new-session-flash`)
- **증거**: `App.tsx:454-478, 1512-1515`; `NewSessionPage.tsx:199, 218-252`
- **상세**: 복원은 두 목록이 모두 도착한 뒤에 실행되기 때문에, 그 전에는 autoFocus된 NewSessionPage(레포가 0개면 '저장소 없음' CTA 포함)가 보입니다. 그 사이에 입력한 내용은 다른 페이지 초안이 됩니다.
- **제안**: 아직 복원하지 않았고 저장된 view-state가 있으면 대화 스켈레톤을 보여 주고, 복원할 대상이 없을 때만 NewSessionPage로 넘어가세요.

#### #44 사이드바 '다시 시도'에 진행 표시도 실패 피드백도 없음 — medium / S
- **렌즈**: state-coverage (`sidebar-retry-swallows-errors`)
- **증거**: `App.tsx:681, 714` (`.catch(() => {})`) vs `:716` (refetchAutomations는 loadFailed를 다시 설정); `Sessions.tsx:350-354`; `RepoTree.tsx:284-288`
- **상세**: 데몬이 계속 응답하지 않으면 Retry를 눌러도 화면이 전혀 바뀌지 않습니다. Automation과 패턴도 다릅니다.
- **제안**: Retry 중에는 busy로 표시하고, 실패하면 loadFailed를 다시 설정하거나 toast를 띄우세요.

#### #45 settings.get이 실패하면 설정 버튼은 활성으로 보이는데 페이지가 안 열림 — medium / S
- **렌즈**: state-coverage (`settings-null-button-noop`)
- **증거**: `App.tsx:609, 1254, 1337, 1611-1612`
- **상세**: 라우팅이 `overlay==='settings' && s.settings` 조건이라서 settings가 null이면 기존 화면이 그대로 보입니다. 그런데 버튼은 활성으로 바뀝니다. 다른 오버레이와 달리 로딩/실패 폴백이 없습니다.
- **제안**: 스켈레톤이나 '설정을 불러오지 못했어요 — 다시 시도'를 렌더하고, 실패를 store 플래그로 남기세요.

#### #46 사용량 데이터가 비어 있으면 '불러오는 중…'이 끝나지 않음 — medium / S
- **렌즈**: state-coverage (`usage-loading-forever`)
- **증거**: `UsagePanel.tsx:107, 130-136, 188-193`; `App.tsx:110-117`
- **상세**: 응답은 성공했지만 수치가 없을 때(ccusage 미설치, 집계 대기 등) 로딩 문구가 계속 남고, 4초마다 다시 요청합니다. 상태바에서는 빈칸이 됩니다. 한 번 값을 받은 뒤의 실패는 오래된 값만 보여 주고 아무 표시가 없습니다.
- **제안**: '사용량 정보 없음 — ccusage/로그인 확인' 빈 상태를 보여 주고, 값이 있는데 실패했다면 흐린 '갱신 실패' 표시를 붙이세요.

#### #47 auth/integrations 상태 요청이 실패하면 설정이 '확인 중…'에 영원히 머묾 — medium / S
- **렌즈**: state-coverage (`settings-checking-forever`)
- **증거**: `App.tsx:612-615`; `SettingsPage.tsx:362-376, 441-446`
- **상세**: codex만 실패 시 'unavailable'로 바뀌고, Claude 인증과 GitHub/Linear는 '확인 중…'에서 끝나지 않습니다. 다시 확인할 수단도 없습니다.
- **제안**: 실패를 'unknown'으로 남겨서 '확인하지 못했어요 · 다시 확인'을 보여 주고, 설정에 들어올 때 한 번 다시 요청하세요.

#### #48 워크플로 에이전트 기록 로드 실패에 재시도 수단이 없음 — medium / S
- **렌즈**: state-coverage (`workflow-history-failed-no-retry`)
- **증거**: `views/WorkflowRuns.tsx:231-237, 297-298`
- **상세**: 빨간 텍스트만 나옵니다. 같은 에이전트를 다시 누르면 재시도되지만 그 사실을 알 수 없습니다. 다른 패널은 실패 문구 자체가 재시도 버튼입니다.
- **제안**: 실패 문구를 버튼으로 만들고, 누르면 loadAgentHistory를 다시 호출하세요.

#### #49 Catalog 탭에서 작업이 실패하면 탭 전체가 '로드 실패' 화면으로 바뀜 — medium / S
- **렌즈**: state-coverage (`library-action-error-replaces-tab`)
- **증거**: `capabilities/CapabilityLibraryTab.tsx:215, 241, 256, 282-284`
- **상세**: Import 실패나 생성 후 reload 실패가 load 에러와 같은 state를 써서 목록, 검색, 툴바가 모두 사라집니다. Retry를 누르면 원인 메시지도 함께 사라집니다. 검증 메모: 팩별 refresh/trust/remove는 카드 안에서 인라인으로 처리됩니다.
- **제안**: load 에러와 action 에러를 분리하고, action 에러는 인라인 배너나 toast로 보여 주세요.

#### #89 repos.list가 실패하거나 늦으면 '등록된 저장소 없음' CTA가 잘못 뜸 — medium / M
- **렌즈**: state-coverage (`repos-list-failure-false-empty`)
- **증거**: `App.tsx:606, 1277`; `RepoTree.tsx:283-290`; `NewSessionPage.tsx:218-252`
- **상세**: repos.list 실패는 조용히 삼켜지고, 빈 상태 판정은 fleetLoaded만 봅니다. NewSessionPage에는 loaded 개념이 없어서 콜드스타트 중에도 '저장소 등록' 박스가 나옵니다.
- **제안**: store에 reposLoaded/reposLoadFailed를 추가하고, 로드가 끝난 뒤에만 빈 상태와 CTA를 보여 주세요. 실패하면 재시도 행을 보여 주세요.

#### #90 Capability Center가 변경 브로드캐스트가 올 때마다 목록 전체를 스피너로 교체함 — medium / M
- **렌즈**: state-coverage (`capabilities-refetch-blanks-content`)
- **증거**: `CapabilitiesPage.tsx:184-196, 336-337`; `CapabilityLibraryTab.tsx:230-240`; `CapabilityAssignmentsTab.tsx:74-77, 147`; shot 26
- **상세**: `capabilities.changed`(파일 감시 200ms 디바운스 포함)가 올 때마다 `setSnapshot(null)`과 `setLoading(true)`로 215개 항목이 사라지고 'Loading…'으로 바뀝니다. 읽는 중에 스크롤 위치도 잃습니다.
- **제안**: 처음 불러올 때만 전체 로딩을 보여 주고, 이후에는 stale-while-revalidate로 기존 데이터를 유지한 채 refresh 아이콘만 회전시키세요.

#### #112 '다시 시도' 버튼이 화면마다 수제 클래스로 구현됨 — low / S
- **렌즈**: visual-consistency (`adhoc-retry-buttons`)
- **증거**: `CapabilitiesPage.tsx:343`; `AutomationPage.tsx:124`; `Sessions.tsx:353`; `RepoTree.tsx:287`
- **상세**: Capabilities만 Button outline sm을 쓰고, 나머지는 raw button이라 높이, radius, 글자 크기, 색이 다릅니다.
- **제안**: 모두 `<Button variant="outline" size="sm">`으로 바꾸세요.

#### #114 파일 트리 검색이 walk가 끝나기 전에 '일치 항목 없음'을 표시함 — low / S
- **렌즈**: state-coverage (`filetree-filter-premature-no-matches`)
- **증거**: `FileTree.tsx:110-115, 225-226`
- **상세**: walk가 끝나기 전에는 결과가 0개로 보이고, walk 실패는 조용히 삼켜져서 그 상태가 영구히 남습니다. truncated 여부도 표시하지 않습니다.
- **제안**: walk 상태(loading/error/truncated)를 따로 두고 '검색 중…', 재시도, '결과가 잘렸어요'를 보여 주세요.

#### #115 Activity 빈 상태 문구가 '아직…'이고 내부 용어를 씀 — low / S
- **렌즈**: state-coverage, ux-complexity (2건 병합: `activity-empty-copy-misleading`, `activity-empty-jargon`)
- **증거**: `views/ActivityPanel.tsx:19-20`; `i18n/ko/workflowActivity.ts:26`; `i18n/en/rightSidebar.ts:4-5`; shot 17, 18b
- **상세**: 종료된 워커에도 'No workflow or nested-agent activity yet.'가 나옵니다. 중첩 에이전트는 live-only라서 '아직'은 기대만 남기고, 'nested agent'는 SDK 내부 용어입니다.
- **제안**: 상태별로 문구를 나누고(종료됨: '기록된 활동이 없어요 — 하위 에이전트 활동은 실행 중에만 표시돼요') 사용자 관점 용어를 쓰세요.

#### #136 빈/에러 상태 아이콘 크기가 제각각이고 알림 빈 상태에 이모지가 있음 — low / M
- **렌즈**: visual-consistency, pixel-pass (2건 병합: `empty-state-glyph-drift`, `attention-empty-emoji`)
- **증거**: `AutomationPage.tsx:131`; `MessageList.tsx:75,89`; `CapabilitiesPage.tsx:340,415`; `capabilities/*Tab.tsx`; `i18n/en/attentionBell.ts:5`; shot 30
- **상세**: 아이콘이 24/25/26/28/30px이고 여백도 py-16과 py-20이 섞여 있습니다. 'Smooth sailing ✨'는 renderer에서 유일하게 이모지를 쓰는 문구로, 스킬의 "Empty states: one 13px muted line, no glyphs" 규칙과 IDE 톤에 맞지 않습니다.
- **제안**: EmptyState 공용 컴포넌트로 통일하고, attentionBell.empty의 이모지를 ko/en 모두에서 빼세요('Nothing needs your attention.').

#### #137 리소스 모니터 IPC가 실패하면 팝오버가 스켈레톤에 갇힘 — low / M
- **렌즈**: state-coverage (`resource-monitor-skeleton-forever`)
- **증거**: `App.tsx:390`; `ResourceMonitor.tsx:157`; shot 31
- **상세**: 실패가 무시되고 snapshot이 null로 남아서 영원히 로딩처럼 보입니다. 실제로 reject되는 경우는 드뭅니다.
- **제안**: 연속 실패 횟수를 세서 일정 횟수가 넘으면 안내와 새로고침 버튼을 보여 주세요.

### T7. Settings · Automation 폼

#### #50 MCP 토큰 재생성이 확인 없이 실행되고 성공 toast가 'Key saved'로 뜸 — medium / S
- **렌즈**: interaction-feedback (`mcp-regenerate-wrong-toast`)
- **증거**: `App.tsx:1380-1384`; `SettingsPage.tsx:231`; `i18n en toast.keySaved`
- **상세**: 기존 URL이 즉시 무효가 되어 등록된 외부 클라이언트 연결이 끊기는데, 확인 단계가 없고 성공 문구도 엉뚱합니다(#103의 일반 규칙과 관련).
- **제안**: '기존 URL을 쓰는 클라이언트 연결이 끊겨요' ConfirmDialog를 거치게 하고, '토큰을 재생성했어요 — 외부 클라이언트를 다시 등록하세요' toast를 띄우세요.

#### #51 Claude 마스터 기본 모델은 Slack 탭에, 나머지 모델 기본값은 Models 탭에 흩어져 있음 — medium / S
- **렌즈**: ux-complexity (`settings-master-model-in-slack`)
- **증거**: `SettingsPage.tsx:339-351, 477-495, 553-589`; `i18n/en/settings.ts:21-22`
- **상세**: masterSpeed와 Codex 마스터 모델은 Models 탭에 있는데 Claude 마스터 모델/effort만 Slack 탭 하단에 있습니다. 같은 'non-UI 전용' 근거를 가진 값들이 서로 다른 탭에 나뉘어 있습니다.
- **제안**: Models > Claude로 옮겨서 Codex 섹션과 같은 Master/Worker/Speed 구조로 맞추세요.

#### #52 설정 카피에 사라진 UI 이름과 실제 범위와 다른 제목이 남아 있음 — medium / S
- **렌즈**: copy-i18n (`settings-stale-copy`)
- **증거**: `i18n/ko/settings.ts:20,76,123-124,130`; `i18n/en/settings.ts:20,76,123,133`; `SettingsPage.tsx:500-568`
- **상세**: 'Codex 워커 백엔드'라는 제목 아래에 마스터 모델과 인증까지 있습니다. '워커 스폰 모달'과 '워커 생성 다이얼로그'는 지금은 전체 페이지(WorkerSpawnPage)입니다.
- **제안**: 제목을 'Codex 백엔드'로, 설명을 '마스터와 워커에 적용돼요'로 바꾸세요. '모달/다이얼로그'는 '워커 스폰 화면'으로 고치세요.

#### #53 자동화 '다음 실행'이 UTC ISO 원문 그대로 나오고, 트리거 접두어는 영어로 하드코딩됨 — medium / S
- **렌즈**: copy-i18n (`automation-raw-iso-and-hardcoded-prefix`)
- **증거**: `AutomationPage.tsx:29,34,40,151`; `src/core/scheduler.ts:64,70`; shot 43
- **상세**: '2026-11-15T18:00:00.000Z' 같은 원문이 그대로 나와서, 폼에서 고른 시간대와 맞지 않습니다. 'worker: ', 'slack: ', 'once · '는 번역 없이 이어 붙여서 'worker: orbitkit · 종료/완료'처럼 섞여 나옵니다.
- **제안**: lib/relative-time으로 locale에 맞게 포맷하세요. 접두어는 triggerWorker/Slack/Once 키로 분리하세요.

#### #54 자동화 폼 카피가 오해를 부르거나 내부 키를 노출함 — medium / S
- **렌즈**: copy-i18n (`automation-copy-misleading`)
- **증거**: `i18n/ko|en/automationModal.ts:10-14`; `automationForm.ts:12-13`; `ko/runAutomationDialog.ts:3`; `ko/automationPage.ts:11,15`; shot 32
- **상세**: '워커 완료 시'는 기본값이 중지+실패라서 사실과 다르고, en 'Worker settled'는 내부 용어입니다. '종료됨 (stop/캡)'의 '캡'은 설명 없는 은어입니다. costBudgetHint는 설정 키 `workerCostBudgetUsd`를, bypassWarning은 코드 토큰 `bypassPermissions`를 그대로 노출합니다. '임의 실행'은 '무작위'로 읽히고, 목록의 '완료'와 폼의 '작업 완료 (idle)'도 다릅니다.
- **제안**: '워커 상태 변경 시', '중지됨 (수동 중지·예산/턴 한도)', '비우면 설정 > 일반의 워커 기본 비용 예산 사용', '수동 실행'으로 바꾸고, 경고 문구는 UI 라벨('Bypass Permissions')을 쓰세요.

#### #91 폼마다 라벨·섹션 타이포가 다르고 섹션 제목과 필드 라벨이 같은 말을 반복함 — medium / M
- **렌즈**: visual-consistency, copy-i18n, pixel-pass, ux-complexity (4건 병합: `form-label-systems`, `duplicate-heading-label-unlabeled-speed`, `settings-redundant-labels-hierarchy`, `settings-double-headings`)
- **증거**: `SettingsPage.tsx:30-49, 187-191, 204-205, 253-254`; `AutomationForm.tsx:233-256`; `WorkerSpawnPage.tsx:411-424`; `i18n/en/automationModal.ts:6,31,45,46`; shot 22, 23, 32, 42
- **상세**: 필드 라벨이 Settings는 13px medium fg, AutomationForm은 12px fg-dim, Spawn 'More'는 11px muted입니다. 'Agent name' 섹션 아래 'Agent name', 'Language' 아래 'Language', 'Trigger' 아래 'Trigger', 'Action' 아래 'Action'처럼 같은 말이 반복되고, semibold와 medium 차이가 작아서 위계가 드러나지 않습니다. 920px에서는 첫 화면에 설정이 3개 정도만 보입니다. 폴더 경로 입력은 말줄임표 없이 글자 중간에서 잘립니다. 검증 메모: Git 'Changes 1'은 카운트 배지라서 이 항목에서 제외했습니다(#38 참고). 라벨 없는 SpeedControl은 #92에서 다룹니다.
- **제안**: ui/에 FormField(13px medium 라벨, 12px muted hint, control 아래)와 FormSection을 만들어 세 폼이 함께 쓰게 하세요. 필드가 하나뿐인 섹션은 제목을 없애고 '제목 + 한 줄 설명 + 컨트롤'로 줄이세요. 경로 입력에는 앞부분 말줄임과 title을 쓰세요.

#### #92 SpeedControl이 라벨 없는 고스트 드롭다운이라 무엇을 고르는 컨트롤인지 알 수 없음 — medium / M
- **렌즈**: visual-consistency, ux-complexity (2건 병합: `speed-control-ghost-in-forms`, `speed-label-no-context`)
- **증거**: `SpeedControl.tsx:38-52` (border-0, bg-transparent, h-6, title은 관측값이 있을 때만); `AutomationForm.tsx:496`; `SettingsPage.tsx:477-479, 539-540`; shot 17, 32
- **상세**: 컴포저용 고스트 칩 스타일이 폼에도 그대로 들어가서, AutomationForm에서는 전체 폭 테두리 Select들 사이에 라벨 없이 'Standard (default)'만 떠 있습니다. 'Standard'가 속도인지 요금제인지 품질인지 알 수 없고, Fast의 비용과 적용 시점을 설명하는 speed.hint는 Settings에서만 보입니다.
- **제안**: `variant: 'chip' | 'field'`를 추가해서 폼에서는 Select md 스타일과 'Speed' 라벨을 쓰세요. 칩에서는 'Speed: Standard'나 아이콘 접두를 붙이고, title은 항상 speed.hint로 채우세요.

#### #93 Settings 저장 방식이 셋으로 섞여 있고 Save 버튼은 화면 밖에 있거나 사라짐 — medium / M
- **렌즈**: interaction-feedback, ux-complexity (2건 병합: `settings-save-offscreen-and-hidden`, `settings-mixed-save`)
- **증거**: `SettingsPage.tsx:117-127, 255, 279-285, 300, 466, 589, 600-604, 612`; shot 22
- **상세**: Language와 Slack On/Off는 즉시 반영되고, 키와 토큰은 각자 Save/Connect 버튼이 있고, 나머지는 스크롤 맨 아래의 고정되지 않은 Save로 저장합니다. 긴 General 탭에서는 Save가 화면 밖에 있어서 저장되지 않은 상태가 보이지 않습니다. Integrations/Capabilities 탭에서는 footer가 숨겨져 저장할 방법이 사라집니다. 미저장 경고는 헤더 X에만 걸려 있어서 사이드바로 나가면 편집이 버려집니다. UnsavedChangesConfirm의 'Save'는 결과를 기다리지 않고 닫기 때문에, 저장이 실패하면 편집이 사라집니다.
- **제안**: footer를 sticky로 하고 dirty일 때 '저장 안 된 변경 N개'와 탭 점을 표시하세요. 모든 탭에서 Save를 유지하고, onSave가 Promise를 반환하게 해서 성공한 뒤에만 닫으세요. 즉시 반영되는 항목에는 표시를 붙이세요.

#### #94 API 키·토큰 저장 시 응답 전에 입력을 비우고 'Saved'로 표시해서 실패해도 되돌아가지 않음 — medium / M
- **렌즈**: interaction-feedback (`settings-key-optimistic-clear`)
- **증거**: `SettingsPage.tsx:300, 409, 466, 589`; `App.tsx:1351-1378`
- **상세**: Codex/Slack/Anthropic/Linear 키 4곳 모두 요청을 보내자마자 입력을 비웁니다. Codex는 placeholder도 'Saved'로 바꿉니다. 실패하면 toast만 뜨고, 입력한 키는 사라지고, '저장됨' 표시는 남습니다.
- **제안**: onSave*가 Promise를 반환하게 하고, 성공했을 때만 입력을 비우고 saved 상태를 켜세요. 진행 중에는 Button loading을 쓰세요.

#### #95 920 폭 Settings에서 설명문이 좁은 칼럼으로 눌리고 한국어가 음절 단위로 끊김 — medium / M
- **렌즈**: pixel-pass (`settings-narrow-description-column`)
- **증거**: `SettingsPage.tsx` Row; shot 23, 42
- **상세**: 사이드바(240)와 설정 nav(200)가 폭을 차지해서 설명문이 약 260px 칼럼에 5–6줄로 늘어집니다. `word-break: keep-all`이 없어서 '비우/면', '추/정치'처럼 끊깁니다(Markdown.tsx에는 적용되어 있습니다).
- **제안**: 좁은 폭에서는 라벨과 입력을 세로로 쌓고, 한국어에 keep-all을 적용하세요. nav를 상단 탭으로 바꾸는 것도 고려하세요.

#### #96 자동화 폼이 Action보다 실행 설정을 먼저 묻는데 그 필드는 Action에 따라 바뀜 — medium / M
- **렌즈**: ux-complexity (`automation-form-order`)
- **증거**: `AutomationForm.tsx:251, 353, 474, 478-496, 518-530`; shot 32, 33
- **상세**: Trigger → Execution → Action 순서인데, Execution의 기본 모델과 속도, maxTurns 표시 여부는 맨 아래 Action 종류에 따라 달라집니다. 가장 중요한 prompt/task는 스크롤 맨 아래에 있습니다.
- **제안**: Basic → Trigger → Action → Execution(접힌 Advanced) 순서로 바꾸세요.

#### #97 자동화 행의 'Enabled' 체크박스와 액션 4개가 항상 노출되고 삭제 구분이 약함 — medium / M
- **렌즈**: interaction-feedback, pixel-pass, ux-complexity (3건 병합: `automation-delete-hover-inconsistent`, `automation-enabled-checkbox`, `automation-row-actions`)
- **증거**: `AutomationPage.tsx:156-167`; 비교 `Sessions.tsx:316`, `RepoTree.tsx:261` (hover:text-fail); `App.tsx:1427`; shot 24, 25, 43
- **상세**: 꺼진 행에도 '☐ Enabled'가 붙어 있어서 상태 표시인지 켜는 버튼인지 헷갈리고, 회색 상태 점과 의미도 겹칩니다. History, Play, Pencil, Trash가 같은 무게로 항상 보이고, Trash만 hover해도 빨간색이 되지 않습니다(세션/레포는 빨개집니다). 삭제를 확인한 뒤에도 낙관적 제거가 없어서 행이 잠시 남습니다. History 아이콘은 체크포인트 아이콘과 같습니다. 행을 눌러서 편집하는 경로는 없습니다.
- **제안**: Enabled를 on/off 스위치로 바꾸고, Run만 상시 노출하고 나머지는 hover나 '…'로 내리세요. Trash에는 `hover:text-fail`과 낙관적 제거를 적용하고, 행 클릭은 편집으로 연결하세요.

#### #110 Settings 컨트롤 폭이 들쭉날쭉하고 Browse 버튼이 입력보다 낮음 — low / S
- **렌즈**: visual-consistency (`settings-control-jag`)
- **증거**: `SettingsPage.tsx:40-49, 189, 196-197, 206, 216`; `ui/button.tsx:21`; `ui/input.tsx:15`; shot 22, 42
- **상세**: 240/120/180px 컨트롤이 오른쪽 정렬되어 있어서 왼쪽 시작선이 지그재그입니다. Input은 h-7(28px)인데 옆 Browse는 h-6(24px)입니다.
- **제안**: 컨트롤을 라벨 아래 좌측 정렬로 두거나 열 폭을 하나로 고정하세요. 입력 옆 버튼은 size md로 하세요.

#### #119 사용량 갱신 주기·Codex 타임아웃을 밀리초로 직접 입력하게 함 — low / S
- **렌즈**: ux-complexity (`settings-ms-units`)
- **증거**: `i18n/en/settings.ts:48,144`; `SettingsPage.tsx:248, 575-578`; shot 22
- **상세**: 120000이 2분이라는 것을 바로 알기 어렵고, 0을 하나 더 넣는 실수도 쉽습니다.
- **제안**: 초나 분 단위로 입력받고 '= 2분' 보조 텍스트를 붙이세요. 아니면 select로 바꾸세요.

#### #134 오버레이 페이지 헤더의 패딩과 구성이 페이지마다 다름 — low / M
- **렌즈**: visual-consistency (`page-header-drift`)
- **증거**: `NewSessionPage.tsx:162-165`; `WorkerSpawnPage.tsx:207-209`; `SettingsPage.tsx:155-157`; `AutomationPage.tsx:111-113`; `AutomationForm.tsx:203-208`; `CapabilitiesPage.tsx:245-260`; shot 01, 22, 25, 26, 29
- **상세**: px-4와 px-5가 섞여서 제목 x좌표가 4px 다르고, 닫기 버튼도 수제 rounded-md와 Button ghost iconSm이 섞여 있습니다. 아이콘, 헤더 탭, 브레드크럼 구성도 페이지마다 다릅니다.
- **제안**: PageHeader 공용 컴포넌트(title, breadcrumb?, actions, onClose)를 만들어 h-10 px-4로 고정하세요.

### T8. Capability Center

#### #63 Capability Center 안에서 Library/Catalog, Effective/유효 상태 이름이 서로 다름 — medium / S
- **렌즈**: copy-i18n (`capability-naming-drift`)
- **증거**: `i18n/ko/capabilities.ts:4,5,11,20,72`; `en/capabilities.ts:72`; `ko/repositorySettings.ts:5,12`; `ko/settings.ts:7`; shot 45
- **상세**: 탭 이름은 '카탈로그'인데 오류 문구는 '라이브러리'입니다. '유효 상태' 탭 아래에 'Effective 대상'과 'Effective 미리보기'가 있습니다. capability도 대소문자와 번역 여부가 제각각입니다.
- **제안**: '카탈로그를 불러오지 못했어요', '확인 대상', '유효 상태 미리보기'로 통일하고, capability 표기는 하나로 정하세요.

#### #64 Capability 화면에 내부 용어(authoritative, tombstone, desired)가 노출되고 비문도 있음 — medium / S
- **렌즈**: copy-i18n (`capability-jargon-leak`)
- **증거**: `i18n/ko|en/capabilities.ts:31,57,59,60,117-119,123`; shot 26, 45
- **상세**: '권위 있는 범위 대상', '비활성 tombstone', 'Desired/적용 예정', '원하는 리비전'이 그대로 나오고, en 'Applied revision none yet'은 비문입니다. 'activation blocked'만 소문자로 시작합니다.
- **제안**: '적용할 범위 대상을 선택하세요', '이 범위에서 끄기', '목표 리비전', 'No revision applied yet'으로 바꾸세요.

#### #98 Capability Center Effective 화면의 정보 과밀(0 카운터, 메타 반복, 줄바꿈) — medium / M
- **렌즈**: visual-consistency, copy-i18n, pixel-pass, ux-complexity (4건 병합: `capability-summary-wrap`, `capability-row-unlabeled-meta`, `capability-rows-repetitive-meta`, `capabilities-effective-overload`)
- **증거**: `CapabilitiesPage.tsx:134-138, 300-317, 351-363`; `src/core/capabilities/builtins.ts:91,109`; `service.ts:94`; shot 26, 27, 45
- **상세**: 8칸 카운터는 보통 7칸이 0이고, 920px에서는 flex-wrap 때문에 5칸+3칸으로 폭이 달라집니다. 둘째 줄 첫 칸에 불필요한 구분선이 생기고, 'Applies next turn'은 두 줄로 꺾입니다. 위쪽에는 revision 해시, 검사 시각, 전체 cwd가 있습니다. 215개 행마다 'Claude supported commands · Worker · Runtime verified · Claude'가 라벨 없이 똑같이 붙어서 'Claude'가 두 번 나오고, 출처 문자열은 데몬이 넣은 영어 리터럴이라 ko에서도 번역되지 않습니다. 행 높이가 120–150px라서 한 화면에 5개 정도만 보이고, 무엇을 조치해야 하는지가 보이지 않습니다.
- **제안**: 0 카운터는 숨기거나 흐리게 하고, 그리드는 `grid-cols-[repeat(auto-fill,minmax(112px,1fr))]`로 바꾸세요. revision은 접힘 'Details'로 내리세요. 공통 메타는 대상 헤더에 한 번만 두고, 목록은 종류별 그룹 헤더가 있는 dense list로 바꾸세요. 데몬 source는 코드값(예: `claude-builtin`)으로 보내고 renderer에서 현지화하세요.

#### #113 Capability 대상 카드에서 라벨 문장까지 모노스페이스 — low / S
- **렌즈**: visual-consistency (`mono-on-label-text`)
- **증거**: `CapabilitiesPage.tsx:316-327`; `globals.css:5`; shot 26, 27
- **상세**: 'Desired revision', 'Inspected …'처럼 라벨 단어까지 font-mono라서 "every mono run is a figure" 규칙과 다릅니다.
- **제안**: 라벨은 sans muted로 두고 해시와 시각만 font-mono span으로 감싸세요.

### T9. 시각 토큰 · 공용 컴포넌트 · 피드백 패턴

#### #55 Usage 미터가 평소엔 주황, 70%부터 하늘색이라 위험도 색 순서가 뒤집힘 — medium / S
- **렌즈**: visual-consistency (`usage-meter-accent-fill`)
- **증거**: `UsagePanel.tsx:23-27` (비교: 같은 파일 `:81` MeterInline은 중립 채움); SKILL.md:21, 57
- **상세**: 0–69%는 bg-accent, 70–89%는 bg-run, 90% 이상은 fail입니다. 정상 상태가 가장 튀고 주의 단계는 오히려 차분합니다. 스킬은 "orange gauge bars"를 금지하고 "80%를 넘을 때만 경고색"을 요구합니다.
- **제안**: `near ? 'bg-fail' : w >= 80 ? 'bg-warn' : 'bg-fg-dim'`로 바꾸세요(#100의 warn 토큰 필요).

#### #56 Pin/Archive가 응답 왕복 전까지 아무 반응이 없음 — medium / S
- **렌즈**: interaction-feedback (`pin-archive-no-optimistic`)
- **증거**: `App.tsx:685-686, 698-707, 712`
- **상세**: Delete는 낙관적으로 바로 사라지는데, Pin/Archive는 refetch가 끝나야 반영됩니다. 그동안 눌리지 않은 것처럼 보이다가 행이 갑자기 다른 섹션으로 이동합니다.
- **제안**: pinned/archived를 즉시 setState로 바꾸고, 실패하면 되돌린 뒤 toast를 띄우세요.

#### #99 탭·세그먼트 활성 표시가 6가지로 다름 — medium / M
- **렌즈**: visual-consistency (`tab-active-treatments-drift`)
- **증거**: `dockview-theme.css:51-54, 104-108`; `CapabilitiesPage.tsx:250, 407`; `ui/segment.tsx:72, 89`; `GitChanges.tsx:158-165`; `TerminalPanel.tsx:67`; shot 02, 19, 26
- **상세**: bg-raised 채움, fg-dim 밑줄, accent 밑줄, accent 밑줄 + bg-accent/15 워시, pill 트랙, 터미널 accent 밑줄이 섞여 있습니다. Segment underline의 주황 워시는 스킬이 금지한 "orange-washed active tab"입니다. 검증 메모: Sessions 소스 필터의 티어 구분은 이전 감사(#52)에서 의도한 것입니다.
- **제안**: '탭 스트립 = 한 가지 색의 1px 라인'과 '폼 내부 = Segment pill' 두 가지로만 정의하세요. 수제 탭은 Segment underline으로 바꾸고 워시는 없애세요.

#### #100 '실행 중' 하늘색(run)이 경고 색으로도 쓰임(warn 토큰 없음) — medium / M
- **렌즈**: visual-consistency (`run-color-as-warning`)
- **증거**: `globals.css:31-35`; `AutomationForm.tsx:380,473,607`; `NewSessionPage.tsx:176-177`; `DaemonDownBanner.tsx:11`; `MonacoEditor.tsx:108`; `CapabilitiesPage.tsx:367-389`; `CapabilityScopeBindings.tsx:117,124`; `ResourceMonitor.tsx:82`; `Sessions.tsx:267 vs 286`; shot 32
- **상세**: bypassPermissions 경고, 인증 차단 배너, DaemonDown, 외부 변경 배너, 70% 임계치가 모두 '실행 중' 색입니다. 경고가 파란 링크처럼 읽히고, 미읽음 dot과 작업 중 dot은 크기만 다릅니다. 과거 감사(#79)에서 raw yellow를 run으로 바꾼 결과입니다.
- **제안**: `@theme`에 `--color-warn`(앰버)을 추가해서 경고와 임계치를 옮기고, run은 실행 상태에만 쓰세요. 미읽음 dot은 다른 채널로 분리하세요.

#### #101 선택/활성 행 표시가 중립·주황 틴트·주황 텍스트로 제각각 — medium / M
- **렌즈**: visual-consistency, pixel-pass (2건 병합: `selection-highlight-drift`, `new-session-active-orange`)
- **증거**: `FileTree.tsx:325`; `CommitView.tsx:60`; `FileMentionPopup.tsx:33`; `PromptEditor.tsx:372`; `WorkflowRuns.tsx:79`; `App.tsx:1143-1145, 1271`; `Sessions.tsx:245, 262`; `ui/input.tsx:10`; shot 02, 16, 46, 47
- **상세**: 사이드바 행과 Settings는 bg-raised이고, FileTree, CommitView, 팝업, WorkflowRuns는 bg-accent/10–15입니다. Sessions/Repos 네비는 text-fg, '+ 새 세션'은 text-accent입니다. 세션 rename input만 주황 테두리입니다. 스킬 규칙은 "selection is neutral, never accent-tinted"입니다.
- **제안**: 선택은 bg-raised + text-fg로 통일하고, 필요하면 2px accent 좌측 라인만 쓰세요.

#### #102 다이얼로그마다 패딩·그림자·폭이 다르고 미저장 확인창만 별도 구현 — medium / M
- **렌즈**: visual-consistency, interaction-feedback (2건 병합: `dialog-chrome-drift`, `settings-unsaved-dialog-handrolled`)
- **증거**: `ui/confirm-dialog.tsx:42`; `FileTree.tsx:297`; `RestartDaemonDialog.tsx:26`; `ForkDialog.tsx:96`; `SettingsPage.tsx:623-640`; `RepoModal.tsx:37`; `DataConsentModal.tsx:43`; `OnboardingModal.tsx:45`
- **상세**: 패딩은 p-5/6/7, 그림자는 없음/shadow-lg/shadow-pop, 폭은 340–480px로 흩어져 있습니다. 공용 ConfirmDialog와 FileTree 다이얼로그는 그림자가 없어서 납작해 보입니다. Settings UnsavedChangesConfirm은 portal 없이 만든 모달이고, Cancel만 raw button(rounded-lg)이라 옆 버튼과 높이가 다릅니다.
- **제안**: ui/dialog.tsx 패널(rounded-xl, p-5, shadow-pop, sm 360 / md 480)을 만들어 공유하고, ConfirmDialog에 세 번째 버튼 옵션을 추가하세요. 최소한 Cancel은 `<Button variant="outline" size="sm">`으로 바꾸세요.

#### #103 파괴적 작업의 확인 방식이 모달/2단 클릭/확인 없음으로 제각각 — medium / M
- **렌즈**: interaction-feedback (`destructive-confirm-inconsistent`)
- **증거**: `CheckpointMenu.tsx:101-115`; `CapabilityLibraryTab.tsx:79-87, 152-157`; `SettingsPage.tsx:231` + `App.tsx:1380-1384`; `WorkspaceHeaders.tsx:131`; `TerminalPanel.tsx:34`
- **상세**: 삭제와 git revert는 ConfirmDialog, Checkpoint Revert와 pack 삭제는 같은 버튼을 두 번 누르는 방식입니다. 복구할 수 없는 secret 삭제, MCP 토큰 재생성(#50), Reset layout(#79), 실행 중인 터미널 닫기에는 확인이 없습니다.
- **제안**: 복구할 수 없는 작업은 ConfirmDialog, 가볍고 되돌릴 수 있는 작업은 Undo toast로 규칙을 정하세요.

#### #109 세션 목록과 워커 트리의 hover 강도가 다름 — low / S
- **렌즈**: visual-consistency (`sidebar-row-hover-mismatch`)
- **증거**: `Sessions.tsx:256-263`; `RepoTree.tsx:158-163, 222`
- **상세**: '공유 토큰'이라는 주석과 달리 hover가 bg-raised/60과 bg-raised로 다릅니다. 두 파일 모두 '2px accent inset' 주석이 있지만 실제 클래스에는 없습니다.
- **제안**: 행 클래스를 lib 상수 하나로 추출하세요.

#### #111 팝오버·메뉴 표면 스타일이 혼재하고 Resource 라벨이 대문자로 하드코딩됨 — low / S
- **렌즈**: visual-consistency (`popover-surface-drift`)
- **증거**: `OpenInAppMenu.tsx:145,154`; `CheckpointMenu.tsx:91`; `FileMentionPopup.tsx:28`; `PromptEditor.tsx:367`; `ContextMenu.tsx:39`; `ResourceMonitor.tsx:112`; `AttentionBell.tsx:161,173`; `i18n/en/resourceMonitor.ts`; shot 30, 31
- **상세**: bg-raised와 bg-surface, rounded-lg와 rounded-md, p-1과 p-1.5가 섞여 있고 행 hover도 둘로 갈립니다. 'MEMORY', 'RAM SHARE'는 대문자입니다.
- **제안**: 공용 menu 표면 상수(bg-surface, rounded-lg, p-1, hover:bg-raised)를 쓰고, 라벨은 'Memory', 'RAM share'로 바꾸세요.

#### #135 한 행 안에서 아이콘 크기가 섞이고 stroke가 IDE 기준(1.5)과 다름 — low / M
- **렌즈**: visual-consistency (`icon-size-stroke-mix`)
- **증거**: `RepoTree.tsx:238,248,258`; `RookeryTab.tsx:103`; `TerminalPanel.tsx:63`; `App.tsx:1229,1252`; `WorkspaceHeaders.tsx:73`; shot 17
- **상세**: 레포 헤더 행에서 Plus만 14px이고 나머지는 12px입니다. renderer의 47개 lucide 사용 파일 중 strokeWidth 1.5는 1곳뿐입니다(스킬 기준은 14px/1.5).
- **제안**: 행 액션 아이콘은 14px로 통일하고, 래퍼나 Provider로 전역 strokeWidth 1.5를 지정하세요.

### T10. 카피 · i18n

#### #57 워커/세션 삭제 확인 문장에서 동사가 빠지고 조사가 틀림 — medium / S
- **렌즈**: copy-i18n (`delete-confirm-broken-sentence`)
- **증거**: `RepoTree.tsx:337`; `Sessions.tsx:414`; `en/repoTree.ts:21`; `en/sessions.ts:15`; `ko/repoTree.ts:21`
- **상세**: 이름 span 뒤에 번역 문자열을 이어 붙이기 때문에 en에서는 'changelog test? This removes…'처럼 'Delete'가 빠집니다. ko 워커 삭제는 ' 를 삭제할까요?'로 공백이 끼고 받침과 관계없이 '를'이 붙습니다. 검증 메모: ko 세션 삭제는 '세션을'로 되어 있어서 이 문제가 없습니다.
- **제안**: 보간 키로 바꾸세요. en "Delete '{name}'? …", ko "'{name}' 워커를 삭제할까요?"

#### #58 중지 관련 용어(중지/중단/종료/End/Stop)가 뒤섞여 턴 중단과 워커 중지를 구분하지 못함 — medium / S
- **렌즈**: copy-i18n, ux-complexity (2건 병합: `stop-terminology-drift`, `worker-lifecycle-verbs`)
- **증거**: `ko/status.ts:10`; `ko/repoTree.ts:14`; `ko/notice.ts:21`; `ko/automationPage.ts:12`; `ko/workflowActivity.ts:9`; `ko/composer.ts:16-17`; `ko/app.ts:32`; `en/repoTree.ts:14-19` ('End'); `en/app.ts:32`; `RepoTree.tsx:326-329`; shot 16, 17
- **상세**: 컴포저 'Stop/중단'은 턴만 멈추고, 메뉴 'End/종료'는 워커를 끝내며, 결과 상태는 'Stopped/중지됨'입니다. 같은 개념이 중지·중단·종료·ended로, 메뉴 동작과 결과 상태가 다른 단어로 불립니다. Archive와 Delete까지 있어서 차이는 hint를 읽어야 압니다.
- **제안**: 턴은 'Interrupt/중단', 워커는 'Stop worker/중지'로 통일하세요(결과 상태와 같은 단어). agentEndedReadonly는 'Worker stopped — view only'로 바꾸세요.

#### #59 같은 상태가 'STOP' / '→ stop' / 'Stopped' 세 가지로 표기되고 ko에서도 영어 약어로 남음 — medium / S
- **렌즈**: visual-consistency, ux-complexity (2건 병합: `status-word-three-forms`, `status-tags-untranslated`)
- **증거**: `lib/status.ts:8-11`; `RepoTree.tsx:188`; `MessageList.tsx:142`; `StatusBadge.tsx:34`; shot 17, 40, 41
- **상세**: 트리는 'STOP/RUN/BG/ORPH', 마스터 워커 카드는 '→ stop', 헤더는 'Stopped/중지됨'입니다. 앱에서 유일한 대문자 텍스트라 튀고, 한국어 UI에서도 'STOP'이 그대로 남습니다. 'ORPH'와 'BG'는 뜻을 추측하기 어렵습니다. 권한 모드의 영어 노출은 #104에서 다룹니다. 검증 메모: 짧은 TAG는 색맹 대응 보조 채널로 의도한 것이라서(부록의 기각 항목 참고) 문제는 '약어 자체'가 아니라 미번역과 세 가지 표기의 불일치입니다.
- **제안**: `status.short.*` 현지화 키(예: '중지', '실행', '백그라운드')를 만들어 트리와 카드에 쓰고, sentence case로 표기하세요.

#### #60 상태바 'Session · 5h'가 앱의 Session 개념과 겹치고 provider 탭이 텍스트처럼 보임 — medium / S
- **렌즈**: copy-i18n, ux-complexity (2건 병합: `usage-session-term-collision` ×2)
- **증거**: `i18n/ko|en/usagePanel.ts:7`; `UsagePanel.tsx:111-130`; shot 02, 22, 40
- **상세**: 5시간 과금 창이 'Session · 5h $66.69'로 표시되어, 헤더의 실제 세션 비용($0.05)과 함께 보이면 혼동됩니다. ko에는 '5h'만 남습니다. 'Claude Codex' 토글은 밑줄이나 구분선 없이 밝기만 달라서 버튼으로 안 보입니다.
- **제안**: '5시간 한도/5h window'로 바꾸고 tooltip에 '계정 전체'를 명시하세요. provider 토글은 'Claude ▾' 드롭다운이나 구분자와 hover를 주세요.

#### #61 'Revert'가 체크포인트 복원과 git 되돌리기에 함께 쓰이고 흐름 안에서 동사가 바뀜 — medium / S
- **렌즈**: copy-i18n, ux-complexity (2건 병합: `revert-restore-mix`, `revert-word-double-meaning`)
- **증거**: `en/checkpointMenu.ts:3-8`; `en/toast.ts:16`; `ko/checkpointMenu.ts:4,5,8`; `ko/toast.ts:16`; `en/gitChanges.ts:5,17-19`; `WorkspaceHeaders.tsx:176`; shot 17
- **상세**: 헤더의 'Revert'는 턴 체크포인트 복원이고, Git 패널의 'Revert'는 파일 폐기(되돌릴 수 없음)라서 같은 화면에 같은 단어가 두 번 나옵니다. 체크포인트 흐름 안에서도 en은 Revert → Revert → 'Restored', ko는 되돌리기 → '정말 복원?' → 되돌렸어요로 동사가 바뀝니다. 검증 메모: 메뉴 상단 힌트가 범위(추적 파일만)를 설명하고 있어서, '범위 설명 누락'은 과장이었습니다.
- **제안**: 헤더는 'Checkpoints/체크포인트로 복원…', git 쪽은 'Discard changes/변경 폐기'로 나누세요. 체크포인트 흐름은 한 동사로 통일하고 확인 문구는 '턴 {turn} 시점으로 파일을 되돌릴까요?'로 하세요.

#### #62 Claude/Codex 선택을 '백엔드/Provider/제공자'로 각각 다르게 부름 — medium / S
- **렌즈**: copy-i18n (`backend-provider-term`)
- **증거**: `ko/automationForm.ts:5`; `ko/workerSpawnModal.ts:17`; `ko/forkDialog.ts:7`; `ko/capabilities.ts:15` ('Provider' 미번역); `ko/speed.ts:3`; `ko/dataConsent.ts:4`
- **상세**: '에이전트 백엔드', '대상 백엔드', 'Provider', '제공자', 'LLM 제공자'로 불러서 같은 선택이라는 것을 알기 어렵습니다.
- **제안**: '백엔드/Backend'로 통일하세요(데이터 동의의 'LLM 제공자'만 예외).

#### #65 ko 워커 스폰 화면에 spawn/label/base 영어가 남고 스폰/생성 용어가 섞임 — medium / S
- **렌즈**: copy-i18n (`ko-spawn-page-english`)
- **증거**: `ko/workerSpawnModal.ts:25,26,33,37,38`; `ko/toast.ts:8,14`; `ko/repoTree.ts:5`; shot 44
- **상세**: 'label (선택)', 'base: 기본(origin)', 'spawn 시점에 고정돼요'가 화면에 보입니다. 메뉴는 '워커 스폰…', toast는 '워커를 생성했어요'라서 용어가 다릅니다. 검증 메모: `spawn` 값 자체는 aria-label이라 화면에는 보이지 않습니다.
- **제안**: '라벨 (선택)', '기준: 기본 브랜치(origin)', '워커를 스폰했어요'로 통일하세요.

#### #66 ko에서 Workflow/워크플로/Phase/Dynamic Workflow가 섞임 — medium / S
- **렌즈**: copy-i18n (`workflow-term-mix`)
- **증거**: `ko/workspaceHeaders.ts:14`; `ko/workflowActivity.ts:4,17,18,27`; `WorkspaceHeaders.tsx:53`; `WorkflowRuns.tsx:318`
- **상세**: 헤더 배지는 'Workflow · {count}'이고, 패널은 '워크플로 실행', 단계는 'Phase {index}', fallback은 'Dynamic Workflow'입니다.
- **제안**: '워크플로 · {count}', '단계 {index} · {title}', fallback '워크플로'로 바꾸세요.

#### #104 한국어 UI에 미번역 영어 라벨(속도·권한·Capabilities 등)이 섞임 — medium / M
- **렌즈**: copy-i18n, pixel-pass (2건 병합: `ko-speed-perm-untranslated`, `ko-mixed-language`)
- **증거**: `ko/speed.ts:7,15,16,20,22-23`; `ko/composer.ts:11-14`; `ko/workerSpawnModal.ts:23-24`; `settings.tabCapabilities`/`capabilities.title`/`app.capabilityCenter` (ko와 en이 같은 값); shot 40, 42–46
- **상세**: '높음'(번역됨) 옆에 'Standard (기본)', 'Bypass Permissions'가 영어로 나옵니다. speed ko는 'Master 속도', 'Worker 속도'처럼 다른 곳(106곳)에서 쓰는 '마스터/워커'와 다르고, 세미콜론도 씁니다. 'Capabilities', 'Capability Center'도 미번역입니다. 날짜 포맷은 #121, 해요체/합니다체 혼용은 #122에서 다룹니다.
- **제안**: 속도는 '표준/빠름', 권한은 '권한 우회/기본/계획 모드/편집 자동 승인'으로 번역하고(SDK 용어는 tooltip에), 'Worker'는 '워커'로, 세미콜론은 문장 분리로 바꾸세요. 고유명사로 둘 항목은 원칙을 정해 effort 등과 일관되게 하세요.

#### #105 i18n을 거치지 않은 하드코딩 문자열(에러 수, input/result, Daemon, off 등) — medium / M
- **렌즈**: copy-i18n (`hardcoded-untranslated-strings`)
- **증거**: `ToolGroup.tsx:36`; `ToolBlock.tsx:117,123`; `UsagePanel.tsx:43`; `StatusBar.tsx:47,49,53`; `WindowControls.tsx:28,34`; `MetricsView.tsx:24,26`; `SettingsPage.tsx:206`; `AutomationForm.tsx:509`; shot 17, 42
- **상세**: '{n} error'는 ko에서도 영어이고 en에서는 '2 error'처럼 복수형이 틀립니다. 'input/result', 'limit', 'Daemon', aria-label 'Minimize/Close', 'ctx/tok', placeholder 'off'도 i18n 밖에 있습니다. AGENTS.md는 placeholder와 aria-label도 i18n을 거치도록 요구합니다.
- **제안**: toolGroup.errors, toolBlock.input/result, usagePanel.limit, common.minimize 같은 키를 추가하고, 'off'는 '제한 없음/No limit'으로 바꾸세요.

#### #120 어텐션 벨 무시 버튼이 '묵살'로 번역됨 — low / S
- **렌즈**: copy-i18n (`ko-dismiss-mukssal`)
- **증거**: `ko/attentionBell.ts:4,14`; `AttentionBell.tsx:186`
- **상세**: '묵살'은 강하게 부정적인 말입니다. 스크린리더 라벨이라 노출 범위는 좁습니다. '어텐션 큐'도 음차입니다.
- **제안**: '닫기'와 '알림 대기열 ({count}건)'으로 바꾸세요.

#### #121 Capability·사용량 시각이 앱 언어가 아니라 OS locale로 포맷됨 — low / S
- **렌즈**: copy-i18n (`date-format-ignores-app-locale`)
- **증거**: `CapabilitiesPage.tsx:327`; `UsagePanel.tsx:19` (비교: `AssistantMessage.tsx:55`, `lib/relative-time.ts:29`); shot 45
- **상세**: 한국어 UI에 '11/15/2026, 5:14:03 PM 확인'처럼 나옵니다.
- **제안**: `useLocale()`의 locale을 넘기고, 상대 시간 표기도 고려하세요.

#### #122 ko 카피에서 해요체와 합니다체가 섞이고 반말·잘린 문장이 있음 — low / S
- **렌즈**: copy-i18n (`ko-tone-drift`)
- **증거**: `ko/images.ts:3-23`; `ko/speed.ts:3-21`; `ko/settings.ts:96,143,145,147`; `ko/capabilities.ts:18,62`; `ko/forkDialog.ts:5-6`; `ko/checkpointMenu.ts:8`; `SettingsPage.tsx:205`; shot 42
- **상세**: 8개 파일이 합니다체이고, 비용 예산 hint는 한 문단 안에서 어미가 바뀝니다. '우선 적용돼 —'는 반말, '정말 복원?'은 잘린 문장입니다.
- **제안**: ko 전체를 해요체로 통일하세요.

#### #123 effort를 '강도'와 'effort'로 섞어 씀 — low / S
- **렌즈**: copy-i18n (`effort-term-inconsistent`)
- **증거**: `ko/settings.ts:17-25`; `ko/composer.ts:8`; `ko/forkDialog.ts:13`; `ko/automationForm.ts:7`; `ko/workerSpawnModal.ts:20`; `en/forkDialog.ts:13`
- **상세**: Models 탭 안에서도 두 표기가 섞이고, en forkDialog만 소문자입니다.
- **제안**: 하나로 정하세요(예: ko '추론 강도', en 'Effort').

#### #124 헤더 메트릭(ctx, tok, 종료 사유)에 설명이 없음 — low / S
- **렌즈**: copy-i18n (`metrics-abbrev-unexplained`)
- **증거**: `MetricsView.tsx:22-33`; shot 17, 40
- **상세**: '5% ctx 48.0k tok 13턴 $0.14'에 tooltip이 없고, 비용이 무엇의 비용인지도 설명이 없습니다. 비정상 종료 사유는 'api_error' 같은 원문 그대로입니다.
- **제안**: 칩마다 title을 붙이고, terminalReason은 `sessionMetrics.reason.*` 키로 현지화하세요.

#### #125 idle을 '유휴/대기 중/대기 상태'로 섞어 씀 — low / S
- **렌즈**: copy-i18n (`idle-term-inconsistent`)
- **증거**: `ko/status.ts:9`; `ko/notify.ts:3`; `ko/capabilities.ts:64`; `ko/automationModal.ts:14`
- **상세**: '유휴'는 '할당된 일을 모두 끝냄'이라는 뜻을 전달하지 못합니다.
- **제안**: '대기 중'으로 통일하세요.

#### #126 제품명이 'rookery'와 'Rookery'로 섞임 — low / S
- **렌즈**: copy-i18n (`brand-capitalization`)
- **증거**: `ko/onboarding.ts:3-4`; `ko/settings.ts:32,45,89`; `ko/daemonDownBanner.ts:4`; `ko/capabilities.ts:10,124`; `WindowControls.tsx:26` (그 밖에 app.ts, dataConsent.ts 등)
- **상세**: 설명 카피에서 브랜드 표기가 섞여 있습니다.
- **제안**: 사용자 대상 카피는 'Rookery'로 통일하세요(CLI와 경로만 소문자).

#### #127 ko 카피에서 2인칭 '당신'을 씀 — low / S
- **렌즈**: copy-i18n (`ko-dangsin-address`)
- **증거**: `ko/attentionBell.ts:16`; `ko/onboarding.ts:4,8`
- **상세**: 번역투로 읽힙니다. 다른 문구는 주어를 생략합니다.
- **제안**: '세션이 답을 기다리고 있어요'처럼 주어를 생략하세요.

#### #128 en 보관 섹션 제목 'Archive 3'이 동작 버튼처럼 읽힘 — low / S
- **렌즈**: copy-i18n (`archive-heading-reads-as-action`)
- **증거**: `en/sessions.ts:12,16`; `en/repoTree.ts:10,17`
- **상세**: 컨텍스트 메뉴 동작도 'Archive'라서 명사와 동사가 충돌합니다(ko는 '보관함'과 '보관'으로 구분되어 있습니다).
- **제안**: 섹션 제목을 'Archived ({count})'로 바꾸세요.

#### #138 worktree·fleet·transcript·diff 용어가 원문/음차/번역어로 섞임 — low / M
- **렌즈**: copy-i18n (`ko-transliteration-mix`)
- **증거**: `ko/app.ts:26`; `ko/onboarding.ts:9-10`; `ko/repoModal.ts:5`; `ko/sideConversation.ts:6`; `ko/workerSpawnModal.ts:25,37`; `ko/settings.ts:32,34,89`; `ko/sessions.ts:15`; `ko/restartDaemonDialog.ts:4`
- **상세**: 'worktree'와 '워크트리', '워커 fleet'과 '플릿', '전사'와 '트랜스크립트', '디프'가 섞여 있습니다. '전사'는 '戰士'로도 읽힙니다.
- **제안**: 용어집을 정해서(워크트리 / 워커 플릿 / 대화 기록 / 변경사항) 일괄 치환하세요.

#### #139 같은 '레포'를 repo/Repository, 레포/저장소로 섞어 씀 — low / M
- **렌즈**: copy-i18n (`repo-term-inconsistent`)
- **증거**: `en/app.ts:17`; `en/repoModal.ts:3`; `en/workerSpawnModal.ts:4`; `en/capabilities.ts:9,125-126`; `en/repositorySettings.ts:3`; `ko/gettingStarted.ts:17`; `ko/dataConsent.ts:4`
- **상세**: en은 repo와 Repository가 반반이고, ko는 대부분 '레포'인데 gettingStarted와 dataConsent만 '저장소'입니다.
- **제안**: en은 한쪽으로, ko는 '레포'로 통일하세요.

### T11. 키보드 · 접근성

#### #67 ContextMenu를 닫아도 포커스가 원래 버튼으로 돌아오지 않음 — medium / S
- **렌즈**: a11y-keyboard (`contextmenu-focus-not-restored`)
- **증거**: `ContextMenu.tsx:15-32`; `lib/useFocusTrap.ts:14,37-39`; `Sessions.tsx:398-408`
- **상세**: Esc나 항목 선택으로 닫으면 포커스가 body로 떨어집니다. 메뉴에서 연 ConfirmDialog도 이전 요소(menuitem)가 사라진 상태라서 Cancel 뒤 포커스를 잃습니다. Tab을 막지 않아서 메뉴가 열린 채 포커스만 빠져나가고, Home/End도 없습니다.
- **제안**: 열 때 activeElement를 저장해 두고 닫을 때 복원하세요(다이얼로그를 여는 경우 포함). Tab은 닫기로 처리하고 Home/End를 추가하세요.

#### #68 FileTree의 이름 변경/삭제 등이 우클릭으로만 열림 — medium / S
- **렌즈**: a11y-keyboard (`filetree-no-keyboard-menu`)
- **증거**: `FileTree.tsx:132-144, 196-205, 258-260`; 비교 `RepoTree.tsx:194-212` ('⋯' 버튼)
- **상세**: Sessions/RepoTree에는 audit #45 때 '⋯' 버튼이 들어갔지만 FileTree에는 없습니다. macOS에는 메뉴 키가 없고 F2나 Delete 단축키도 없습니다.
- **제안**: F2→rename, Delete/Cmd+Backspace→delete, Shift+F10→메뉴를 추가하고, hover/focus 때 '⋯'를 보여 주세요.

#### #69 FileTree 검색 결과를 키보드로 탐색하거나 열 수 없음 — medium / S
- **렌즈**: a11y-keyboard (`filetree-filter-keyboard-dead`)
- **증거**: `FileTree.tsx:132-133, 222, 224, 248-252, 311-326`
- **상세**: 필터 모드에서는 onKeyDown이 바로 return해서 Arrow와 Enter가 동작하지 않고, 검색창에서 Enter를 눌러도 첫 결과가 열리지 않습니다. input에는 aria-label이 없습니다. FileRow마다 tab stop이 있어서 roving 선택과 DOM 포커스가 따로 놉니다.
- **제안**: 필터 모드에서도 Arrow/Enter를 지원하고 검색창에서 ArrowDown으로 결과로 이동하게 하세요. aria-label을 붙이고 FileRow에 `tabIndex={-1}`을 주세요.

#### #70 슬래시/@멘션/이슈 팝업에서 화살표로 고른 항목이 스크롤 밖으로 사라짐 — medium / S
- **렌즈**: a11y-keyboard (`popup-selection-not-scrolled`)
- **증거**: `PromptEditor.tsx:236-261, 366-380`; `FileMentionPopup.tsx:27-44`; `WorkerSpawnPage.tsx:262-264, 275`; renderer 전체에 `scrollIntoView` 호출 0건
- **상세**: 하이라이트가 보이는 영역 밖으로 나가서, 무엇을 골랐는지 모른 채 Enter를 누르게 됩니다. PromptEditor 팝업에는 listbox/option과 aria-activedescendant도 없습니다.
- **제안**: 선택이 바뀔 때 `scrollIntoView({block:'nearest'})`를 호출하고, combobox 시맨틱을 연결하세요.

#### #71 dock 탭 overflow chevron에 포커스도 레이블도 없음 — medium / S
- **렌즈**: a11y-keyboard (`dock-overflow-chevron-inaccessible`)
- **증거**: `dockview-core/.../tabOverflowControl.js:2-15`, `tabsContainer.js:241-254`; `WorkspaceDock.tsx:318-320`; shot 20
- **상세**: 기본 overflow 핸들이 click 리스너만 있는 div라서 키보드로 열 수 없고, 스크린리더에는 '2'만 읽힙니다. #2와 겹치면 활성 탭에 접근할 수 없습니다.
- **제안**: 커스텀 overflow 컴포넌트로 `<button aria-label="숨은 탭 N개" aria-haspopup="menu">`를 제공하세요.

#### #72 접고 펴는 버튼 대부분에 aria-expanded가 없음 — medium / S
- **렌즈**: a11y-keyboard (`disclosure-missing-aria-expanded`)
- **증거**: `ToolGroup.tsx:28-29`; `ThinkingBlock.tsx:13-14`; `ToolBlock.tsx:53-54`; `RepoTree.tsx:226-229`; `WorkflowRuns.tsx:179,187,277,285` (비교: UsagePanel, AttentionBell, CheckpointMenu에는 있음)
- **상세**: 펼쳐져 있는지 알 수 없고, 화면마다 처리가 다릅니다.
- **제안**: `aria-expanded={open}`을 넣고 aria-controls를 연결하세요.

#### #73 Side conversation drawer가 Esc로 닫히지 않고 포커스 관리가 없음 — medium / S
- **렌즈**: a11y-keyboard (`side-drawer-no-escape-focus`)
- **증거**: `SideConversationDrawer.tsx:79-163`; shot 36, 37
- **상세**: X로만 닫히고, 열거나 닫을 때 포커스 이동이 없습니다. overlay 모드에서는 사실상 모달인데 Tab이 뒤로 빠져나갑니다.
- **제안**: Esc로 닫고, 열 때 drawer 컴포저에, 닫을 때 트리거로 포커스를 옮기세요. overlay 모드에서만 useFocusTrap을 거세요.

#### #74 승인/질문 InteractionCard가 나타나도 포커스나 단축키가 없음 — medium / S
- **렌즈**: a11y-keyboard (`interaction-card-no-focus`)
- **증거**: `InteractionCard.tsx` (focus/onKeyDown 0건), `:94-101`
- **상세**: 턴이 이 카드에서 막혀 있는데, 응답하려면 Shift+Tab을 여러 번 눌러야 합니다.
- **제안**: 다른 입력 중이 아닐 때 첫 옵션에 포커스를 주거나, Cmd+Enter 승인 힌트와 단축키를 다세요.

#### #75 알림 벨 팝오버를 열어도 포커스가 패널로 이동하지 않음 — medium / S
- **렌즈**: a11y-keyboard (`attention-bell-focus-on-open`)
- **증거**: `AttentionBell.tsx:93-110, 150-156`; 비교 `ResourceMonitor.tsx:33-37, 71-76` (audit #61에서 수정됨); shot 30
- **상세**: ResourceMonitor에서 고친 문제가 AttentionBell에는 그대로 남아 있습니다.
- **제안**: 열 때 첫 항목(없으면 패널)에, 닫을 때 벨 버튼으로 포커스를 옮기세요.

#### #76 이름 변경 등의 Enter 처리에 IME 조합 가드가 없음 — medium / S
- **렌즈**: a11y-keyboard (`ime-enter-no-composition-guard`)
- **증거**: `Sessions.tsx:241`; `RepoTree.tsx:139`; `FileTree.tsx:299`; `WorkerSpawnPage.tsx:264`; 비교 `PromptEditor.tsx:277`, `WorkerSpawnPage.tsx:197`
- **상세**: 기본 로케일이 한국어인데, 마지막 음절을 조합하던 중 Enter를 누르면 제출되거나 하이라이트된 이슈가 선택됩니다.
- **제안**: `if (e.nativeEvent.isComposing || e.keyCode === 229) return;`을 추가하세요.

#### #77 RepoModal·필터·rename input이 placeholder에만 의존하고 레이블이 없음 — medium / S
- **렌즈**: a11y-keyboard (`unlabeled-inputs`)
- **증거**: `RepoModal.tsx:41-57`; `RepoTree.tsx:134, 278`; `FileTree.tsx:222`; `Sessions.tsx:236`
- **상세**: 값을 입력하면 무슨 필드인지 사라지고, 에러 문구가 필드와 연결되어 있지 않습니다.
- **제안**: RepoModal에는 보이는 label을 붙이고, 에러는 aria-describedby/aria-invalid로 연결하세요. 나머지 input에는 aria-label을 주세요.

#### #78 행 액션 버튼의 접근성 이름이 'Delete'/'Edit'뿐이라 어느 항목인지 알 수 없음 — medium / S
- **렌즈**: a11y-keyboard (`generic-row-action-names`)
- **증거**: `AutomationPage.tsx:159-162`; `Sessions.tsx:285-299`; 비교 `RepoTree.tsx:243-244`
- **상세**: 스크린리더나 음성 제어로 들으면 행마다 똑같이 읽힙니다.
- **제안**: aria-label에 항목 이름을 넣으세요(예: `t('automationPage.deleteNamed', {name})`).

#### #82 Cmd/Ctrl+W를 누르면 에디터 탭이 아니라 앱 창이 닫힘 — medium / M
- **렌즈**: a11y-keyboard (`cmd-w-closes-window`)
- **증거**: `main/index.ts:432,470,477` (Menu.setApplicationMenu 없음, window-all-closed→quit); `RookeryTab.tsx:93-103`; shot 19
- **상세**: Electron 기본 메뉴가 Cmd+W를 차지하고 있어서, IDE처럼 탭을 닫으려다 창이 닫힙니다(Windows/Linux에서는 앱이 종료됩니다). 반대로 에디터 탭을 키보드로 닫는 방법은 없습니다.
- **제안**: 앱 메뉴를 직접 정의하세요. Close Window는 Shift+Cmd+W로 옮기고, Cmd+W는 renderer로 보내 활성 에디터 탭을 닫게 하세요(dirty면 확인을 거치고, 대화 탭에서는 아무 동작 없음).

#### #106 리사이즈 핸들과 dock sash가 키보드로 조작되지 않고 더블클릭 초기화도 없음 — medium / M
- **렌즈**: a11y-keyboard, layout-resize (2건 병합: `resize-handles-not-keyboard`, `resize-handle-no-affordance-reset`)
- **증거**: `ResizeHandle.tsx:12-21`; `lib/useResizableWidth.ts:26-49`; `App.tsx:1284`; `RightSidebar.tsx:73`; `dockview-theme.css:25`; `dockview-core/.../splitview.js:356-358`; shot 11, 12
- **상세**: role=separator만 있고 tabIndex, aria-value*, 키 처리가 없습니다. dock sash도 투명한 div입니다. #1처럼 극단으로 끌어 망가졌을 때 IDE 관례인 더블클릭 → 기본 크기 복원이 없습니다. 검증 메모: hover 전에 핸들이 보이지 않는 것은 VS Code 관례라 문제가 아닙니다.
- **제안**: tabIndex=0, aria-valuenow/min/max, 화살표로 16px씩 조절, Home/End, 더블클릭으로 기본 폭 복원을 추가하세요. dock sash에도 더블클릭 리셋을 다세요.

#### #107 세션 행 하나에 tab stop이 최대 4개이고 Arrow 탐색과 aria-current가 없음 — medium / M
- **렌즈**: a11y-keyboard (`sidebar-rows-tab-stops`)
- **증거**: `Sessions.tsx:251-310`; `App.tsx:1139-1151`; `RepoTree.tsx:154-212`; 비교 `FileTree.tsx` (roving 패턴)
- **상세**: 세션이 20개면 목록을 지나가는 데 Tab을 80번 눌러야 합니다. 선택은 배경색으로만 표시됩니다.
- **제안**: roving tabindex와 Arrow 탐색을 적용하고, 활성 행과 nav에 `aria-current='page'`를 주세요.

#### #129 오버레이 페이지마다 Escape 동작이 다름 — low / S
- **렌즈**: a11y-keyboard (`escape-policy-inconsistent-pages`)
- **증거**: `NewSessionPage.tsx:210`; `WorkerSpawnPage.tsx:193-197`; `SettingsPage.tsx:125,157`
- **상세**: New session은 Esc로 닫히고, Spawn은 Esc를 의도적으로 무시하고, Settings/Automation/Capabilities는 반응이 없습니다. Settings에는 이미 미저장 가드가 있어서 Esc를 연결해도 안전합니다.
- **제안**: 초안이 보존되는 페이지와 가드가 있는 Settings는 Esc로 닫게 하세요.

#### #130 이미지 라이트박스가 aria-modal인데 포커스를 받지 않고 닫기 버튼이 없음 — low / S
- **렌즈**: a11y-keyboard (`image-lightbox-focus`)
- **증거**: `MessageImages.tsx:155-175`
- **상세**: 다른 모달과 달리 useFocusTrap이 없어서 Tab이 뒤쪽 UI로 이동합니다.
- **제안**: aria-label이 있는 닫기 버튼과 useFocusTrap을 추가하고, 닫을 때 썸네일로 포커스를 돌려주세요.

#### #131 설정 카테고리 레일(role=tab)에 Arrow 키 탐색이 없음 — low / S
- **렌즈**: a11y-keyboard (`settings-tablist-no-arrows`)
- **증거**: `SettingsPage.tsx:163-182`; 비교 `ui/segment.tsx:55-64`
- **상세**: 탭 패턴이라고 안내되는데 Arrow가 동작하지 않고, 모든 카테고리가 tab stop입니다. tabpanel에도 aria-labelledby가 없습니다.
- **제안**: Segment의 vertical 변형을 재사용하세요.

#### #132 마우스로 클릭한 뒤에도 Tooltip이 남아 있음 — low / S
- **렌즈**: a11y-keyboard (`tooltip-sticks-after-click`)
- **증거**: `Tooltip.tsx:34` (`group-focus-within`); `StatusBar.tsx:77-95`; `App.tsx:1235-1257`
- **상세**: 클릭한 버튼이 포커스를 유지해서, 페이지가 열린 뒤에도 말풍선이 떠 있습니다.
- **제안**: `group-has-[:focus-visible]`로 바꾸고 Esc로 숨기게 하세요.

#### #133 FileTree 이름 대화상자: 실패하면 입력이 사라지고 Esc 취소가 안 됨 — low / S
- **렌즈**: interaction-feedback, a11y-keyboard (2건 병합: `name-dialog-escape-and-validation`, `name-dialog-escape-ignored`)
- **증거**: `FileTree.tsx:155-163, 286-307`; 비교 `Sessions.tsx:242`
- **상세**: `submitName`이 요청 전에 대화상자를 닫아서, 이름 중복이나 권한 오류가 나면 toast만 남고 입력한 이름은 사라집니다. rename할 때 확장자를 뺀 이름이 미리 선택되지 않습니다. Esc는 `escape:'ignore'`라서 취소되지 않습니다. 검증 메모: Esc 무시는 draft 폼 전반에 쓰이는 의도적 컨벤션이라는 의견(interaction-feedback 검증)과, 파일명 한 줄짜리라 잃을 초안이 없으니 예외로 두는 게 맞다는 의견(a11y 검증)이 갈렸습니다. 둘 다 '이 다이얼로그만은 close가 타당하다'는 결론은 같습니다.
- **제안**: 대화상자를 연 채로 검증하고 오류는 인라인으로 보여 주세요. rename 시 basename을 선택하고, 이 다이얼로그만 `escape:'close'`로 하세요.

#### #140 전역 단축키가 사실상 Ctrl+` 하나뿐이고 그마저 안내가 없음 — low / M
- **렌즈**: a11y-keyboard (`global-shortcuts-missing-undiscoverable`)
- **증거**: `WorkspaceDock.tsx:300-309`; `i18n/en/workspaceHeaders.ts:3-7`; `WorkspaceHeaders.tsx:118-125`; `App.tsx:1197`
- **상세**: 사이드바, 오른쪽 패널, 새 세션, 설정 단축키가 없고, Ctrl+`도 tooltip에 표기되지 않습니다.
- **제안**: Cmd+B, Cmd+Alt+B/Cmd+J, Cmd+N, Cmd+,를 붙이고 title과 aria-keyshortcuts에 단축키를 함께 적으세요.

---

## 부록: 기각된 발견 (18건)

| 제목 (렌즈) | 기각 사유 |
|---|---|
| 도크·셸·인스펙터의 표면 문법이 세 가지로 섞임 (visual-consistency) | `apps/desktop/DESIGN.md`가 floating inspector card를 사양으로 명시하고, dockview-theme에도 "space, not lines"라는 의도 주석이 있습니다. 증거 샷에서는 터미널이 열려 있지도 않았습니다. |
| 페이지 본문의 최대 폭과 정렬이 제각각 (visual-consistency) | 핵심 근거가 틀렸습니다. Capability Center에도 `max-w-5xl mx-auto`가 있습니다. 나머지 폭 차이는 레이아웃 유형이 달라서 생긴 100px 내외 차이입니다. |
| Git·Files 패널 IPC가 reject되면 스켈레톤이 영원히 돎 (state-coverage) | root는 항상 resolveRoot로 먼저 허용 목록에 들어가고, exec는 reject하지 않습니다. CommitView는 root가 바뀌면 다시 요청해서 스스로 회복합니다. 재현 경로가 없습니다. |
| 마스터 Stop/InteractionCard 응답 실패 시 '진행 중'이 풀리지 않음 (interaction-feedback) | WS 아웃박스가 연결이 끊긴 동안 메시지를 버퍼링합니다. 마스터에 Recover가 없는 것은 문서화된 의도입니다. respond 실패 경로는 카드가 이미 resolved된 뒤에만 생깁니다. |
| Settings에서 즉시 적용/Save/행별 저장이 섞임, 표시 없음 (interaction-feedback) | Language 즉시 적용은 apps/desktop/AGENTS.md에 명시되어 있고, 토큰 Save는 입력 바로 옆에 있어서 혼동 근거가 약합니다(관련된 화면 밖 Save 문제는 #93에 반영했습니다). |
| RepoTree 'STOP' 태그가 정지 버튼처럼 보임 (interaction-feedback) | 다른 태그와 같은 평문 스타일이고, hover하면 사라지고 '⋯'로 바뀝니다. stopped 워커에는 Stop 액션 자체가 없습니다. |
| 워커 헤더에 Stop/Archive/Delete가 없음 (interaction-feedback) | 주석이 RepoTree 메뉴로의 이동을 명시한 의도적 설계입니다. 백그라운드 태스크 kill은 헤더에 이미 있고, 사이드바는 한 번 클릭으로 펼쳐집니다. |
| 우측 패널 토글이 그룹 단위라 탭 하나만 다시 열 수 없음 (ia-navigation) | audit #48의 의도적 parity입니다. 토글을 한 번 누르면 숨긴 패널만 show되므로 "다시 열 방법이 없다"는 주장은 사실과 다릅니다(부분 상태 표시 문제는 #8로 남겼습니다). |
| 'STOP' 태그가 버튼처럼 읽힘 (ia-navigation) | STOP 태그와 Stop 메뉴는 같은 행에 동시에 있을 수 없습니다. 색맹 대응 축약은 주석에 명시된 의도적 설계입니다. |
| 상태 태그가 두 locale 모두 영어 약어 (copy-i18n) | audit #50 계획 문서가 짧은 TAG는 유지하고 tooltip을 전체 단어로 하는 방식을 명시적으로 선택했고, 테스트로도 고정되어 있습니다(불일치와 미번역 측면은 #59의 ux/visual 근거로 남겼습니다). |
| 우측 Files 탭 아이콘이 X로 바뀌어 보임 (pixel-pass) | hover할 때만 X로 바뀌도록 의도적으로 구현했습니다(라벨 가림 해결). 캡처 순간 마우스가 탭 위에 있었습니다. |
| 우측 세그먼트 활성 표시가 크기에 따라 밑줄/박스로 오감 (pixel-pass) | 현재 icon variant 코드에는 두 모양으로 갈리는 경로가 없습니다. 캡처가 최신 빌드와 맞지 않습니다. |
| 우측 패널만 둥근 카드라 좌측 사이드바와 다름 (pixel-pass) | T3 Code를 본뜬 의도적 디자인으로, 주석과 DESIGN.md에 명시되어 있습니다. |
| 종료된 워커의 view-only 컴포저가 일반 입력창과 똑같이 보임 (pixel-pass) | disabled 상태에서 이미 흐려지고, Stopped 배지와 STOP 라벨이 함께 표시됩니다. Slack 읽기 전용과 같은 관례입니다(남은 정보 가치 문제는 #117에 반영했습니다). |
| Automation·폼 헤더 제목과 본문 열의 왼쪽 정렬 어긋남 (pixel-pass) | Settings와 Capabilities에도 반복되는 앱 공통 레이아웃 관례이고, 눈에 띄는 문제가 아닙니다. |
| Automation 폼 select가 950px 전폭이고 speed만 고스트 (pixel-pass) | 레티나 2x 측정 오류입니다(실제 폭은 672px). 파란 경고는 audit #79의 결정입니다(speed 라벨 문제는 #92로 남겼습니다). |
| 상태바 오른쪽 아이콘 4개에 라벨이 없고 사용량 위계가 없음 (pixel-pass) | 모든 아이콘에 Tooltip과 aria-label이 있는 IDE 관례이고, 라벨과 값 사이에 밝기 위계가 이미 있습니다. |
| Capability 바인딩 편집 위치가 세 곳 (ux-complexity) | 세 곳이 같은 CapabilityScopeBindings를 공유하고 Effective/Advanced 딥링크까지 갖춘, CLAUDE.md에 문서화된 설계입니다. |
