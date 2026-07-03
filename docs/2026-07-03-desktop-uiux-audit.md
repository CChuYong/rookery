# rookery 데스크톱 UI/UX 감사 — 최종 보고서 (2026-07-03)

- 대상: `apps/desktop` renderer (Electron 미션 컨트롤 앱)
- 입력: 라이브 스크린샷 세트(`.superpowers/uiux-audit/shots/`, Pass A/B) + 소스 코드 라인 대조
- 렌즈 7종: visual-consistency · state-coverage · interaction-feedback · ia-navigation · copy-i18n · a11y-keyboard · pixel-pass
- 집계: 렌즈별 확정 발견 **102건** 중 렌즈 간 중복 **21건을 병합**해 **최종 81건**. 검증 단계에서 기각된 8건은 부록에 기록. 모든 항목은 코드 라인과 스크린샷으로 재현 확인된 것만 포함한다.

---

## 요약

| 심각도 | 건수 |
|---|---|
| high | 3 |
| medium | 49 |
| low | 29 |
| **합계** | **81** |

공수 분포: **S 70건 · M 11건** (L 없음). 인벤토리는 심각도 high→low, 같은 심각도 안에서는 공수 S→M 순으로 정렬했다.

**진행 상태**: Quick wins #1~#41은 브랜치 `uiux/quick-wins`(2026-07-03)에서 전량 구현 완료됐다.

**High 3건**
- **#1** 마스터 세션 전송 실패가 무피드백으로 사라지고 pending 버블·composer가 영구 고착 (`App.tsx` fire-and-forget vs 이미 고쳐진 `subSend` 비대칭)
- **#2** orphaned 워커의 Files/Git 패널이 `Locating work folder…`에 영구 고착 — 4개 렌즈가 독립적으로 재발견한 최다 중복 이슈
- **#3** 워커 스폰(WorkerSpawnModal) 진입점이 hover 전용 `+` 하나 — 발견 불가에 더해 `display:none`이라 키보드로는 도달 자체가 불가능

**패턴 요약**: 가장 큰 군집은 (a) `client.send` fire-and-forget + `.catch(()=>{})`가 App.tsx 전반에 반복되는 **조용한 실패**, (b) 로딩/빈/에러 상태를 구분하지 않는 **상태 커버리지 공백**(false-empty, 무한 로딩), (c) 우클릭·hover 전용 액션의 **발견성/키보드 접근성** 문제, (d) worker/agent·job/automation 등 **용어 혼용과 i18n 누락**, (e) 공용 컴포넌트(Button/Select/모달 계약)를 우회한 **디자인 시스템 드리프트**다.

### Quick wins (심각도 high/medium × 공수 S) — #1~#41, 41건

정렬 규칙상 인벤토리 #1~#41이 전부 quick win이다. 테마별로 묶으면:

- **피드백/조용한 실패**: #1 마스터 send request() 전환 · #4 자동화 폼 인라인 에러 살리기 · #5 새 세션 프롬프트 보존 · #6 워커 모델/권한 롤백 · #7 동의/온보딩 실패 표시 · #8 키 저장 토스트+auth 재조회 · #9 restore 성공 피드백 · #10 저장 실패 전용 배너 · #11 FileTree/OpenInApp 실패 토스트 · #12 승인 카드 in-flight 상태
- **상태 커버리지**: #2 orphaned locating 종료 상태 전환 · #13 FileTree false-empty · #14 목록 fetch 실패 UI · #15 Settings '확인 중' 상태 · #16 체크포인트 에러/빈 구분 · #17 로딩 표현 통일
- **파괴적 액션 가드**: #18 Settings 이탈 경고 · #19 repo 제거 확인 · #20 자동화 삭제 확인
- **발견성/IA**: #3 스폰 `+` 상시 노출+포커스 노출 · #21 필터가 활성 세션 숨김 · #22 Automation 진입 상설화 · #23 busy 중 Stop 유지
- **키보드 접근성**: #24 hover 전용 닫기 X 포커스 노출 · #25 온보딩 모달 a11y · #26 동의 모달 dialog 시맨틱 · #27 스폰 검색 드롭다운 방향키
- **dock 크롬**: #28 diff 탭 `(diff)` 접미사 · #29 dock 탭 타이틀 재로컬라이즈 · #30 빈 터미널 접힌 시드
- **용어/카피/i18n**: #31 worker/agent 통일 · #32 네스티드 패널 명칭 통일 · #33 `xhigh` 표시 라벨 · #34 ko 문자열 내 영어 정리 · #35 Git History 상대시각 locale · #36 eyebrow 클래스/i18n 정렬
- **시각 일관성**: #37 Tooltip `w-max`(ko 세로쓰기 붕괴) · #38 확인 버튼 ghost→primary · #39 disabled primary 회색화 · #40 상태 푸터 nowrap · #41 시크릿 필드 저장 상태 표시

---

## 우선순위 인벤토리

| # | 제목 | 심각도 | 공수 | 주요 컴포넌트 |
|---|---|---|---|---|
| 1 | 마스터 전송 실패가 무피드백 소실 — pending 버블·composer 영구 고착 | high | S | App.tsx, ws/client.ts, ConversationPane.tsx |
| 2 | orphaned 워커 Files/Git 패널이 'Locating work folder…'에 영구 고착 | high | S | RightSidebar.tsx, App.tsx, FileTree.tsx, GitChanges.tsx |
| 3 | 워커 스폰 진입점이 hover 전용 '+' — 발견 불가 + 키보드 도달 불가 | high | S | RepoTree.tsx, WorkerSpawnModal.tsx, App.tsx |
| 4 | 자동화 폼 인라인 에러가 절대 표시되지 않음 (죽은 submitError 경로) | medium | S | AutomationForm.tsx, App.tsx |
| 5 | 새 세션 시작 실패 시 프롬프트 소실 + 초안 미보존 | medium | S | NewSessionPage.tsx, Composer.tsx, store/drafts.ts |
| 6 | 워커 모델/권한모드 낙관 갱신 후 실패 롤백·알림 없음 | medium | S | App.tsx, Composer.tsx |
| 7 | 첫 실행 동의/온보딩 저장 실패 시 모달이 무피드백으로 잔존 | medium | S | DataConsentModal.tsx, OnboardingModal.tsx, App.tsx |
| 8 | API 키/Slack 토큰 저장 성공 피드백 없음 + 인증 상태 카드 미갱신 | medium | S | SettingsPage.tsx, App.tsx |
| 9 | 체크포인트 Revert 성공 피드백 전무 | medium | S | CheckpointMenu.tsx, App.tsx |
| 10 | Cmd+S 저장 실패가 '파일 열기 실패' 배너로 오표시 | medium | S | MonacoEditor.tsx, i18n/monacoEditor |
| 11 | FileTree 파일 조작·Open-in-App 실패가 무피드백으로 무시됨 | medium | S | FileTree.tsx, OpenInAppMenu.tsx |
| 12 | 승인/질문 카드 버튼에 in-flight 상태 없음 — 무응답 시 무피드백 | medium | S | InteractionCard.tsx, App.tsx |
| 13 | FileTree가 로딩 중 'This folder is empty' 표시 + 읽기 실패도 빈 폴더로 위장 | medium | S | FileTree.tsx |
| 14 | 목록 초기 fetch 조용한 실패 시 사이드바 영구 공백·자동화 false-empty | medium | S | App.tsx, Sessions.tsx, RepoTree.tsx, AutomationPage.tsx |
| 15 | Settings Integrations·Claude가 로드 중/실패 시 '연결 안 됨'으로 오표시 | medium | S | SettingsPage.tsx, App.tsx |
| 16 | 체크포인트 목록 조회 실패가 '체크포인트 없음'으로 표시 | medium | S | CheckpointMenu.tsx, App.tsx |
| 17 | 로딩 표현 3종 혼재 (SkeletonRows / 'Loading…' / 무표시 정적 텍스트) | medium | S | App.tsx, RightSidebar.tsx, CheckpointMenu.tsx, CommitView.tsx |
| 18 | Settings 미저장 변경이 닫기/이탈 시 무경고 소실 | medium | S | SettingsPage.tsx, App.tsx |
| 19 | repo 등록 해제가 무확인 hover 원클릭 + 성공 피드백 없음 | medium | S | RepoTree.tsx, App.tsx |
| 20 | 자동화 규칙 삭제가 무확인 아이콘 원클릭 | medium | S | AutomationPage.tsx, App.tsx |
| 21 | 세션 소스 필터가 현재 활성 세션을 목록에서 숨김 | medium | S | Sessions.tsx, store/store.ts |
| 22 | Automation 진입 버튼이 Sessions 탭 사이드바 전용 | medium | S | App.tsx |
| 23 | 턴 진행 중 composer에 입력하면 Stop 버튼이 사라짐 | medium | S | Composer.tsx, WorkspaceHeaders.tsx |
| 24 | 탭/터미널 닫기 X가 hover 전용 — 키보드 포커스 시 완전 비가시 | medium | S | TerminalPanel.tsx, TabBar.tsx, RookeryTab.tsx |
| 25 | OnboardingModal이 모달 a11y 계약(trap·Escape·role·autofocus) 전부 미준수 | medium | S | OnboardingModal.tsx |
| 26 | DataConsentModal에 dialog role·초기 포커스·트랩 없음 | medium | S | DataConsentModal.tsx |
| 27 | WorkerSpawnModal 검색 드롭다운이 키보드로 조작 불가 | medium | S | WorkerSpawnModal.tsx |
| 28 | file 탭과 diff 탭이 동일 라벨('CLAUDE.md')로 나란히 열림 | medium | S | store/workspace.ts, RookeryTab.tsx, TabBar.tsx |
| 29 | dock 패널 타이틀이 생성 시점에 고정·persist — ko에서 영어 크롬 잔존 | medium | S | WorkspaceDock.tsx, RookeryTab.tsx |
| 30 | 빈 터미널 패널이 상시 ~220px 세로 공간 점유 | medium | S | WorkspaceDock.tsx, TerminalPanel.tsx, default-template.ts |
| 31 | 동일한 '워커'를 worker/agent/Claude Agent로 혼용 | medium | S | i18n/locales (repoTree, app, interactionCard) |
| 32 | 네스티드 패널 명칭 3종 혼재 + 빈 상태 영어 하드코딩 | medium | S | workspace/panels.tsx, i18n/rightSidebar·workspaceHeaders·nestedAgents |
| 33 | effort 옵션에 raw 토큰 'xhigh' 노출 + ko 미번역 | medium | S | lib/models.ts, SettingsPage.tsx |
| 34 | ko 문자열 안에 영어 제품 용어 혼입 (New Session, effort, 네임) | medium | S | i18n/locales/ko/settings.ts |
| 35 | Git History 상대시각이 앱 locale이 아닌 git/OS locale을 따름 | medium | S | main/workspace-manager.ts, GitHistory.tsx |
| 36 | 페이지 헤더 eyebrow의 클래스·언어 처리가 화면마다 다름 | medium | S | SettingsPage.tsx, AutomationPage.tsx, NewSessionPage.tsx, globals.css |
| 37 | Tooltip이 ko에서 글자 단위 세로쓰기로 깨짐 ('설/정') | medium | S | Tooltip.tsx |
| 38 | 다이얼로그 긍정 액션 위계 혼재 — variant 미지정 ghost 확인 버튼 | medium | S | RestartDaemonDialog.tsx, RunAutomationDialog.tsx, FileTree.tsx, ui/button.tsx |
| 39 | disabled primary 버튼(opacity-40)이 활성 컬러 버튼처럼 보임 | medium | S | ui/button.tsx, Composer.tsx, InteractionCard.tsx, RepoModal.tsx |
| 40 | 데몬 재시작 중 상태 푸터가 항목 중간에서 줄바꿈 | medium | S | App.tsx |
| 41 | 저장된 write-only 시크릿(Slack 토큰)이 미설정처럼 보임 | medium | S | SettingsPage.tsx |
| 42 | AskUserQuestion 카드에 거절/건너뛰기 수단 없음 | medium | M | InteractionCard.tsx |
| 43 | 대화 트랜스크립트 로딩 상태 부재 — false-empty 번쩍임·실패 시 영구 빈 화면 | medium | M | MessageList.tsx, App.tsx, ConversationPane.tsx |
| 44 | dirty 파일 탭을 닫을 때 무경고로 편집 내용 소실 | medium | M | TabBar.tsx, RookeryTab.tsx, store/workspace.ts |
| 45 | 핵심 액션(rename·fork·stop·archive·delete)이 우클릭 전용 — affordance·키보드 진입 없음 | medium | M | Sessions.tsx, RepoTree.tsx, ContextMenu.tsx |
| 46 | 세션·워커 기본 이름이 폴더/레포명 fallback — 동일 라벨의 벽 | medium | M | Sessions.tsx, RepoTree.tsx |
| 47 | 세션↔워커 교차 탐색 공백 — spawn 카드 칩 의존, 역링크 없음 | medium | M | ToolBlock.tsx, WorkspaceHeaders.tsx, lib/tool-worker.ts |
| 48 | dock 고정 패널(Files/Git/Terminal/Claude Agent)을 숨길 방법 없음 | medium | M | RookeryTab.tsx, WorkspaceDock.tsx, WorkspaceHeaders.tsx |
| 49 | dock 터미널: '(bottom panel)' 라벨 잔재 + 이중 탭바 + 자동 스폰 패리티 상실 | medium | M | TerminalPanel.tsx, WorkspaceDock.tsx, i18n/workspaceHeaders·terminalPanel |
| 50 | 워커 상태 태그: 8.5px 초소형 + 난해 약어(ORPH) + 미번역 + 헤더와 표기 불일치 | medium | M | lib/status.ts, RepoTree.tsx, StatusBadge.tsx |
| 51 | 자동화 규칙 카드가 raw Slack ID(#C05…, @U02…) 노출 | medium | M | AutomationPage.tsx |
| 52 | 'N개 중 하나 선택' 세그먼트 컨트롤이 5가지 시각 문법으로 구현 | medium | M | Sessions.tsx, RightSidebar.tsx, GitChanges.tsx, SettingsPage.tsx, WorkerSpawnModal.tsx |
| 53 | Slack on/off 토글 실패가 무반응으로 종료 | low | S | SettingsPage.tsx, App.tsx |
| 54 | 성공 토스트 어휘가 액션마다 들쭉날쭉 | low | S | App.tsx, store/toasts.ts |
| 55 | 사용량 패널이 로드 전/실패 시 무표시 — pop-in·레이아웃 점프 | low | S | UsagePanel.tsx, App.tsx |
| 56 | 신규 설치 첫 화면부터 계정 전역 사용액이 무설명 노출 | low | S | UsagePanel.tsx |
| 57 | dock 레이아웃 초기화·기본값 지정 수단 없음 | low | S | WorkspaceDock.tsx, store/layout.ts |
| 58 | 레포 0개일 때 New Session에 레포 등록 유도 없음 | low | S | NewSessionPage.tsx |
| 59 | 헤더 open-in-app 스플릿 버튼이 라벨 없는 글리프 — 정체불명 | low | S | OpenInAppMenu.tsx, WorkspaceHeaders.tsx |
| 60 | CheckpointMenu·OpenInAppMenu 팝업에 초기 포커스·방향키 로빙 없음 | low | S | CheckpointMenu.tsx, OpenInAppMenu.tsx |
| 61 | ResourceMonitor 팝오버가 Escape로 닫히지 않음 | low | S | ResourceMonitor.tsx |
| 62 | 안내 문구 동사(diff/discard)가 실제 UI 라벨(Git 탭, Delete…)과 어긋남 | low | S | i18n/locales, RepoTree.tsx |
| 63 | 같은 개념을 'job/작업'과 'automation/자동화'로 혼용 | low | S | i18n/automationPage·automationModal |
| 64 | en 라벨 표기 비일관 — 'register'/'spawn' 소문자, 'effort' 케이싱, '— Model (default) —' | low | S | i18n/repoModal·workerSpawnModal·settings·automationForm |
| 65 | 좌하단 daemon/slack 상태 접미사가 하드코딩 영어 | low | S | App.tsx, i18n/settings |
| 66 | ko 어조가 해요체/합니다체 사이에서 혼재 | low | S | i18n/ko (dataConsent, settings, restartDaemonDialog, gitChanges) |
| 67 | 같은 'Working' 상태를 ko에서 '작업 중'/'처리 중'으로 이원화 | low | S | i18n/ko (app, sessions, workspaceHeaders) |
| 68 | ko '대기 중'이 Idle과 Queued 두 상태에 중복 사용 | low | S | i18n/ko (notify, conversation) |
| 69 | repoModal 힌트 동어반복('path is the path') + 소문자 placeholder | low | S | i18n/repoModal |
| 70 | CommitView '1 files' — 단수형 미처리, 'Changed files 1' 어순 | low | S | CommitView.tsx, i18n/commitView |
| 71 | 'AUTOMATION Automation' — eyebrow와 제목이 같은 단어로 중복 | low | S | AutomationPage.tsx, SettingsPage.tsx |
| 72 | 첫 실행 모달(DataConsent·Onboarding)이 버튼/모달 시스템 이탈 | low | S | DataConsentModal.tsx, OnboardingModal.tsx, ui/button.tsx |
| 73 | 파괴적 confirm 다이얼로그 4곳이 각자 손으로 만든 버튼 세트 | low | S | Sessions.tsx, RepoTree.tsx, GitChanges.tsx, FileTree.tsx |
| 74 | AutomationForm의 raw select 6곳이 공용 Select 우회 — focus ring 없음 | low | S | AutomationForm.tsx, ui/input.tsx |
| 75 | AutomationForm 헤더만 오버레이 헤더 패턴 이탈 + '←' 텍스트 글리프 | low | S | AutomationForm.tsx |
| 76 | 사이드바 Sessions↔Repos 탭 간 리스트 행 스케일 불일치 | low | S | Sessions.tsx, RepoTree.tsx |
| 77 | 섹션 eyebrow 마이크로라벨이 8.5~12px × tracking 4종으로 난립 | low | S | Sessions.tsx 외 7개 파일 |
| 78 | Git 패널 Commit 버튼이 공용 primary와 다른 coral | low | S | GitChanges.tsx, ui/button.tsx |
| 79 | bypassPermissions 경고만 raw tailwind 노랑 사용 | low | S | AutomationForm.tsx |
| 80 | Revert 체크포인트 목록이 시각만 표시 — 자정 넘기면 비단조로 보임 | low | S | CheckpointMenu.tsx |
| 81 | Slack 'Connected' 옆 빨간 'Off' 필이 상태인지 액션인지 모호 | low | S | SettingsPage.tsx |

---

## 테마별 상세

### 테마 1 — 피드백 공백: 조용히 사라지는 실패

`client.send` fire-and-forget과 `.catch(()=>{})`가 App.tsx 전반에 반복되는 구조적 패턴. 워커 전송(`subSend`)은 이미 `request()`+롤백+토스트로 고쳐져 있어, 같은 패턴을 나머지 경로에 복제하는 것이 수정의 핵심이다.

#### #1 마스터 세션 전송 실패가 어떤 피드백도 없이 사라지고 pending 버블이 영원히 '진행 중'으로 남음
- **렌즈**: interaction-feedback · **심각도**: high · **공수**: S
- **증거**: `apps/desktop/src/renderer/App.tsx:527-536` (fire-and-forget send) vs `:555-565` (subSend는 request()+dropWorkerPending+toast, 주석에 이유 명시); `src/daemon/connection.ts:169-178` (reqId 없는 error 응답); `apps/desktop/src/renderer/ws/client.ts:87-96` (reqId 없는 error 프레임 무시); `ConversationPane.tsx:25`
- **상세**: 마스터 composer의 send는 reqId 없는 fire-and-forget이라, 데몬이 `session.send` 실패(unknown session, runTurn throw) 시 보내는 reqId 없는 error 프레임을 `WsClient.handle`이 통째로 버린다. 실패한 전송의 optimistic pending 버블이 롤백되지 않고 영구히 남으며, `busy = pending.length > 0` 로직 때문에 composer가 stop 버튼 상태로 고착되고 토스트도 없다. 정확히 같은 문제로 워커 경로만 이미 고쳐진 비대칭.
- **제안**: `session.send`를 `client.request()`로 전환하고, 실패 시 `dropPending(sid, clientMsgId)` + `toast.error(t("toast.sendFailed"))`로 롤백한다 (subSend 패턴 재사용).

#### #4 자동화 폼의 인라인 에러(잘못된 cron 등)가 절대 표시되지 않음
- **렌즈**: interaction-feedback · **심각도**: medium · **공수**: S
- **증거**: `App.tsx:928-939` (catch 후 rethrow 없음 → 폼 catch 불능); `AutomationForm.tsx:39,112-113,405-407` (죽은 submitError 경로, 스크롤 본문 최하단 배치)
- **상세**: AutomationForm은 submitError 인라인 표시를 갖추고 있지만, App의 onSubmit이 에러를 catch해 토스트만 띄우고 rethrow하지 않아 폼의 catch가 절대 실행되지 않는다. 서버 측 cron 검증 실패가 'Automation action failed' 일반 토스트로만 보이고 어느 필드가 문제인지 폼에 표시되지 않으며, 에러 문단 위치도 Save 버튼보다 아래(스크롤 본문 최하단)라 이중으로 눈에 안 띈다.
- **제안**: App onSubmit에서 실패를 rethrow해 인라인 에러를 살리고, 에러를 cron 필드 바로 아래(또는 헤더 근처)에 표시한다.

#### #5 새 세션 시작 실패 시 입력한 프롬프트가 복구 불가하게 소실되고, 초안 보존도 없음
- **렌즈**: interaction-feedback · **심각도**: medium · **공수**: S
- **증거**: `App.tsx:503-526` (navigate 후 request, catch는 토스트만), `:919,1045` (NewSessionPage에 draft 배선 없음); `Composer.tsx:108-114` (onSend 직후 clear); `ConversationPane.tsx:27-29` (대화 composer는 draft 보존)
- **상세**: Start를 누르면 페이지가 즉시 닫히고 에디터가 clear되는데, `session.create` 실패 시 toast.actionFailed만 뜨고 프롬프트는 사라진다. 대화 composer들은 draft store로 초안을 보존하지만 NewSessionPage만 initialText/onDraftChange가 미배선이라 Esc·닫기·페이지 이탈만으로도 긴 초안이 경고 없이 소실된다.
- **제안**: 새 세션 초안도 draft store(`newSession` 키)로 보존하고, 생성 실패 시 페이지를 다시 열어 초안을 복원한다.

#### #6 워커 모델/권한모드 변경이 낙관적 반영 후 실패 시 롤백·알림이 없음
- **렌즈**: interaction-feedback · **심각도**: medium · **공수**: S
- **증거**: `App.tsx:566-575` (send + 낙관 갱신, 실패 경로 없음); `connection.ts:382-390` (실패 시 error+reqId 응답이지만 reqId가 없어 클라이언트가 버림)
- **상세**: composer의 워커 모델·permission mode 드롭다운은 fleet row를 즉시 낙관적으로 갱신하지만 `worker.setModel/setPermissionMode`는 catch 없는 fire-and-forget send다. 데몬이 거부하면 UI는 적용되지 않은 값을 계속 표시하고, 사용자는 다음 턴이 다른 모델로 도는 것을 보고서야 눈치챈다.
- **제안**: `request()`로 전환해 실패 시 이전 값으로 롤백하고 toast.actionFailed를 표시한다.

#### #7 첫 실행 동의/온보딩 완료 클릭이 실패하면 모달이 무피드백으로 그대로 남음
- **렌즈**: interaction-feedback · **심각도**: medium · **공수**: S
- **증거**: `App.tsx:1134-1138` (Accept `.catch(()=>{})`), `:1143-1147` (onFinish 동일); `DataConsentModal.tsx:21-26` (busy 상태 없는 단일 버튼)
- **상세**: Accept/완료는 settings.set 성공으로 settings가 갱신돼야만 모달이 사라지는데 요청 실패가 삼켜진다. 실패 시 클릭해도 아무 일도 안 일어나는 것처럼 보이고(버튼 busy 상태 없음), 첫 실행 사용자가 이유를 모른 채 차단 모달 앞에 남는다.
- **제안**: 클릭 시 버튼을 loading으로 전환하고 실패 시 모달 안에 인라인 에러('저장 실패 — 다시 시도')를 표시한다.

#### #8 Anthropic API 키/Slack 토큰 저장 시 성공 피드백이 없고 인증 상태 카드가 갱신되지 않음
- **렌즈**: interaction-feedback · **심각도**: medium · **공수**: S
- **증거**: `SettingsPage.tsx:206,333` (저장 즉시 필드 clear); `App.tsx:915-916` (catch만 있고 성공 처리·auth.status 재조회 없음), `:428` (auth.status는 connect 시 1회); Linear는 `:910-913`에 재조회 패턴 존재
- **상세**: 키를 저장하면 입력 필드가 즉시 비워질 뿐 성공 토스트가 없고, auth.status를 재조회하지 않아 'Active authentication' 카드가 여전히 이전 방식/'(없음)'을 표시한다. 사용자가 저장 실패로 오해하고 재입력하게 된다. Slack 토큰 저장도 동일하며, Linear 키만 integrations 재조회로 상태 점이 갱신된다.
- **제안**: settings.set 성공 후 auth.status(Slack이면 slack 상태)를 재조회해 즉시 반영하고 '키 저장됨' 성공 토스트를 추가한다.

#### #9 체크포인트 Revert 확정 후 성공 피드백이 전혀 없음 — 메뉴만 조용히 닫힘
- **렌즈**: interaction-feedback · **심각도**: medium · **공수**: S
- **증거**: `App.tsx:605` (catch만 존재); `CheckpointMenu.tsx:59-62` (확정 후 setOpen(false)뿐); `src/daemon/connection.ts:403-407` (ack만 반환, 이벤트 없음); 스크린샷 a-18
- **상세**: 두 번 클릭으로 되돌리기를 확정하면 메뉴가 닫힐 뿐 토스트·트랜스크립트 notice·헤더 변화가 전혀 없다. 워크트리 파일이 실제로 되돌려졌는지는 Git 패널(2.5s 폴링)을 열어 간접 확인해야 한다. 파괴적 액션인데 완료 여부가 보이지 않는다.
- **제안**: restore 성공 시 'Turn N으로 되돌렸어요' 토스트 또는 워커 트랜스크립트 notice를 추가하고, 진행 중에는 Revert 버튼에 스피너를 표시한다.

#### #10 Cmd+S 저장 실패가 '파일을 열 수 없어요' 배너로 표시됨
- **렌즈**: interaction-feedback · **심각도**: medium · **공수**: S
- **증거**: `MonacoEditor.tsx:49-52` (write 실패 → banner "error"), `:98-99` (openError 문구 렌더); `i18n/locales/en·ko/monacoEditor.ts` (openError는 읽기 실패 전용 문구)
- **상세**: ws.write 실패 시 열기 실패용 배너("이 파일을 열 수 없어요 — 현재 작업 폴더 밖이거나 읽기에 실패했어요")를 재사용한다. 저장이 실패했다는 사실(편집 내용이 디스크에 미반영)이 전달되지 않아, 정상 저장으로 오해한 채 탭을 닫을 수 있다.
- **제안**: 저장 실패 전용 상태(saveError)와 문구('저장하지 못했어요 — 편집 내용이 디스크에 반영되지 않았어요' + 재시도)를 분리한다.

#### #11 FileTree 파일 조작(rename/mkdir/삭제)과 Open-in-App 실패가 아무 피드백 없이 무시됨
- **렌즈**: interaction-feedback · **심각도**: medium · **공수**: S
- **증거**: `FileTree.tsx:113-144` (exists 외 미처리 await + void 호출); `OpenInAppMenu.tsx:45-52` (`catch(()=>{})` + `appLauncher.open`의 `{ok:false}` 반환값 미검사)
- **상세**: submitName/confirmTrash는 새 파일 중복(exists)만 처리하고 rename/mkdir/trash의 reject를 잡지 않아, 실패가 콘솔 unhandled rejection으로만 남고 UI는 무반응이다(다이얼로그는 이미 닫힘). OpenInAppMenu도 실패를 삼키며, orphaned 워커에서는 resolveWorkRoot가 홈 폴더로 폴백해 오히려 홈 폴더가 열려 더 혼란스럽다.
- **제안**: 각 fs 작업을 try/catch로 감싸 toast.error로 실패 사유를 알리고, OpenInApp 실패 시 '폴더를 찾을 수 없어요' 토스트를 추가한다.

#### #12 승인/질문 카드의 버튼이 응답 클릭 후에도 활성 상태로 남음
- **렌즈**: interaction-feedback · **심각도**: medium · **공수**: S
- **증거**: `InteractionCard.tsx:37-38,84` (클릭 후 로컬 상태 변화 없음); `App.tsx:546-548` (fire-and-forget send); 스크린샷 a-27
- **상세**: Approve/Deny/Submit은 fire-and-forget(`interaction.respond`)이고 카드는 `interaction.resolved` 이벤트가 돌아와야만 요약으로 바뀐다. 그 사이 버튼이 활성으로 남고, 연결이 끊긴 상태에서는 클릭이 outbox에 버퍼될 뿐 카드에 표시가 없어 조용히 무시된 것처럼 보인다(중복 응답은 서버가 no-op 처리하므로 실질 위험은 무피드백 쪽).
- **제안**: 첫 클릭 시 카드 로컬로 '응답 전송 중…' disabled 상태로 전환하고(resolved 도착 시 요약 교체), Button의 loading prop을 활용한다.

#### #42 AskUserQuestion 카드에 거절/건너뛰기 수단이 없음 (승인 카드의 Deny와 비대칭)
- **렌즈**: interaction-feedback · **심각도**: medium · **공수**: M
- **증거**: `InteractionCard.tsx:30-42` (approve엔 Deny), `:62-85` (ask엔 Submit만, allAnswered 필수); `src/core/interaction-registry.ts`의 respond도 ask에서 decision 무시; 스크린샷 a-27
- **상세**: 질문 카드는 모든 문항을 선택해야만 Submit이 활성화되고, 제시된 선택지가 모두 부적절할 때 거절하거나 자유 답변할 방법이 없다. 유일한 탈출구는 composer의 Stop으로 턴 전체를 중단하는 것인데 그 연결은 어디에도 안내되지 않는다. 수정 범위가 renderer뿐 아니라 core interaction-registry까지 걸친다.
- **제안**: ask 카드에 '건너뛰기/직접 입력' 보조 버튼(빈 answers 또는 자유 텍스트로 resolve)을 추가한다.

#### #53 Slack on/off 토글 실패가 무반응으로 끝남
- **렌즈**: interaction-feedback · **심각도**: low · **공수**: S
- **증거**: `App.tsx:906` (catch 없는 request — 형제 핸들러 910/915/916은 모두 catch 있음); `SettingsPage.tsx:185-192` (전환 중 상태 없는 토글 버튼)
- **상세**: slack.set request에 catch가 없고 낙관적 상태 변화도 없어, 요청이 실패하면 클릭해도 상태 점·라벨이 그대로다. 성공 시에도 slack.status 이벤트 도착 전까지 전환 중 표시가 없다.
- **제안**: 실패 시 toast.actionFailed 표시 + 요청~상태 이벤트 도착 사이 버튼 loading 표시.

#### #54 성공 피드백(토스트) 어휘가 액션마다 들쭉날쭉함
- **렌즈**: interaction-feedback · **심각도**: low · **공수**: S
- **증거**: `App.tsx:586` (workerSpawned), `:594` (repoRegistered), `:949` (automationRan) vs `:598` (repo 제거 무토스트), `:605` (restore 무토스트), `:915-916` (키 저장 무토스트); `i18n/locales/en/toast.ts` (성공 키가 소수)
- **상세**: worker spawn·repo 등록·automation 수동 실행은 성공 토스트가 있지만 repo 제거·automation 삭제·restore·키 저장·세션/워커 삭제는 조용히 성공한다. 실패 토스트는 거의 전 액션에 있어 비대칭이 뚜렷하고, 특히 화면 변화가 즉각적이지 않은 키 저장·restore에서 성공 여부를 확신할 수 없다.
- **제안**: '화면에 즉시 보이는 상태 변화가 없는 성공은 토스트로 알린다'는 규칙으로 통일하고 toast.saved/removed류 키를 추가한다.

---

### 테마 2 — 상태 커버리지: 로딩·빈·에러 상태의 혼동

로딩/빈/에러가 같은 표현으로 뭉개지는 문제군. 특히 `.catch(()=>{})`+빈 배열 폴백이 "false-empty"(실제로는 실패인데 '없음'으로 표시)를 양산한다.

#### #2 orphaned 워커의 Files/Git 패널이 'Locating work folder…'에 영구 고착 — 실패 상태가 없는 막다른 로딩
- **렌즈**: state-coverage + interaction-feedback + ia-navigation + pixel-pass (4개 렌즈 중복 병합) · **심각도**: high · **공수**: S
- **증거**: `RightSidebar.tsx:49-67` (resolveRoot 300ms×15회 재시도 후 조용히 포기, ready 게이트), `:107-108` (findingWorkDir 렌더); `App.tsx:241-251` (tries<15 후 침묵), `:655`, `:694-695` (`wsRoot.endsWith(workerId)` 조건); `i18n/en/rightSidebar.ts:5`; 스크린샷 a-19, a-02, a-03, a-04
- **상세**: 워커 루트 해석은 root가 워커 id로 끝날 때까지 재시도한 뒤 조용히 포기하는데, 워크트리가 사라진 orphaned 워커는 홈 경로 폴백만 남아 조건이 영원히 성립하지 않는다. 그 결과 Files/Git 패널이 스피너도 에러도 없는 정적 텍스트 'Locating work folder…'를 무기한 표시한다(라이브 캡처 a-19에서 실관측). 사용자는 로딩 중인지 고장인지 구분할 수 없고, 같은 화면 composer는 'diff/discard만 가능'이라 안내하지만 정작 diff를 볼 Git 패널이 이 고착 상태라 안내와 실제가 모순된다.
- **제안**: 재시도 소진 또는 `worker.status`가 orphaned/종료 상태면 즉시 '워크트리를 찾을 수 없어요 — 이미 삭제되었거나 재시작으로 세션이 종료됨' 종료 상태로 전환하고 diff/discard 유도 문구를 붙인다. 진행 중일 때만 스피너를 표시하고, 워크트리가 없으면 composer 문구도 'diff 불가'로 분기한다.

#### #13 FileTree가 디렉터리 로딩 중 'This folder is empty'를 표시하고, 읽기 실패도 빈 폴더로 위장
- **렌즈**: state-coverage · **심각도**: medium · **공수**: S
- **증거**: `FileTree.tsx:46-52` (`list(...).catch(()=>[])`), `:178-179` (rows 0 → emptyFolder); `filetree-model.ts:5-18`; `i18n/en/fileTree.ts:15`
- **상세**: FileTree는 GitChanges/GitHistory와 달리 로딩 스켈레톤이 없다. 초기 진입 시 children 맵이 비어 flatten 결과가 []가 되고 곧바로 'This folder is empty'를 렌더해, 파일이 가득한 워크트리도 목록 도착 전 순간적으로 빈 폴더로 보인다. list() 실패도 빈 배열로 흡수되어 실제 읽기 오류(권한/경로)와 빈 폴더가 구분 불가능하다.
- **제안**: 루트 목록 미로드 상태를 추적해 SkeletonRows를 표시하고, list 실패는 별도 에러/재시도 상태로 분리한다.

#### #14 목록 초기 fetch가 조용히 실패하면 세션/레포 사이드바가 영구 공백, 자동화 목록은 false-empty
- **렌즈**: state-coverage · **심각도**: medium · **공수**: S
- **증거**: `App.tsx:420-422,429` (list 요청 `.catch(()=>{})`); `store/store.ts:202,209` (loaded 플래그는 성공 시만 true); `Sessions.tsx:264`, `RepoTree.tsx:158` (loaded 게이트); `AutomationPage.tsx:70-74` (게이트 없는 empty)
- **상세**: session.list/fleet.list/automation.list 요청이 실패를 삼킨다. Sessions/RepoTree의 빈 상태 안내는 loaded 플래그가 true일 때만 뜨는데 이 플래그는 성공 시에만 켜지므로, 초기 요청이 거부되면 사이드바는 빈 상태 안내조차 없는 공백으로 남는다. 반대로 AutomationPage는 로드 게이트가 없어 fetch 완료 전/실패 시 'No scheduled jobs yet.' false-empty를 노출한다.
- **제안**: 초기 목록 요청 실패 시 재시도 또는 에러/재시도 UI를 사이드바에 노출하고, AutomationPage에도 loaded 플래그를 도입해 로드 전 스켈레톤과 실제 빈 상태를 구분한다.

#### #15 Settings의 Integrations·Claude 패널이 로드 중/조용한 실패 시 '연결 안 됨/인증 없음'으로 오표시
- **렌즈**: state-coverage · **심각도**: medium · **공수**: S
- **증거**: `SettingsPage.tsx:274-278` (GitHub 회색+auth needed), `:283-286` (Linear), `:302-320` (Claude method 기본 none → 'No auth active'); `App.tsx:427-428` (integrations.status/auth.status `.catch(()=>{})`)
- **상세**: integrations와 authStatus가 null인 동안(로드 중이거나 요청이 실패해 영구히) GitHub는 회색 점+'auth needed', Claude 인증은 method='none' 기본값으로 빨간 점+'No auth active'가 뜬다. 실제로는 API 키가 정상 동작 중이어도 '인증 없음'으로 보일 수 있고 '확인 중' 로딩 상태가 없다.
- **제안**: null 동안은 '확인 중…'(중립 점+로딩 문구)을 표시하고 요청 실패는 재시도/에러로 구분한다. 특히 Claude 패널은 미확정 상태에서 'No auth active' 단정을 피한다.

#### #16 체크포인트 목록 조회 실패가 '체크포인트 없음'으로 표시됨
- **렌즈**: interaction-feedback · **심각도**: medium · **공수**: S
- **증거**: `App.tsx:603-604` (`catch(()=>[])`); `CheckpointMenu.tsx:31` (`catch(()=>setItems([]))`), `:54` (items 0 → checkpointMenu.empty)
- **상세**: fetch 실패가 빈 배열로 흡수되어, 데몬 오류·연결 끊김이 'No checkpoints'라는 확정적 빈 상태 문구로 렌더링된다. 롤백 지점이 아예 기록되지 않았다고 오해하게 된다.
- **제안**: fetch 실패를 별도 에러 상태로 구분해 '목록을 불러오지 못했어요 — 다시 시도' 문구+재시도 버튼을 표시한다.

#### #17 로딩 상태 표현이 SkeletonRows / 'Loading…' 텍스트 / 무표시 정적 문구 3종으로 갈림
- **렌즈**: visual-consistency · **심각도**: medium · **공수**: S
- **증거**: `App.tsx:655` (findingWorkDir), `RightSidebar.tsx:107-108` vs `GitChanges.tsx:165` (SkeletonRows), `GitHistory.tsx:18`, `CheckpointMenu.tsx:53`, `CommitView.tsx:29`; 스크린샷 a-19, a-17
- **상세**: GitChanges·GitHistory·ResourceMonitor는 SkeletonRows, CheckpointMenu·CommitView는 맨 텍스트 'Loading…', Files/Git 패널의 'Locating work folder…'는 스피너·스켈레톤 없는 정적 텍스트다. 동일 의미 상태의 시각 표현이 화면마다 달라 대기/실패를 일관되게 판단할 수 없다(정적 텍스트 케이스의 dead-end는 #2).
- **제안**: 로딩은 SkeletonRows로 통일하고, findingWorkDir는 #2의 실패 상태 전환과 함께 별도 문구/톤을 적용한다.

#### #43 대화 트랜스크립트에 로딩 상태가 없어 '빈 대화' 안내가 번쩍이고, fetch 실패 시 영구 빈 화면
- **렌즈**: state-coverage · **심각도**: medium · **공수**: M
- **증거**: `MessageList.tsx:39-46` (items 0이면 emptyHint); `App.tsx:465-468` (select→즉시 navigate 후 history 비동기 seed, `.catch(()=>{})` — 325,329,433,434,477,552행 동일), `ConversationPane.tsx:20` (EMPTY 폴백); `i18n/en/messageList.ts` (emptyHint)
- **상세**: 세션/워커 선택 시 화면은 즉시 전환되지만 트랜스크립트는 history가 비동기로 도착해야 채워진다. 그 전까지 items 0으로 판단해 'Type a message to start a conversation with the master.'가 떠, 이력이 있는 세션도 잠깐 빈 세션처럼 보인다. history 요청 실패가 삼켜지므로 실패 시 이력 있는 세션이 영구히 빈 대화 안내에 머문다. 이 문구는 워커 화면에서도 그대로 나와 'with the master'로 오표기된다.
- **제안**: 세션별 '이력 로드 완료' 플래그를 두고 미로드 시 스켈레톤 표시, `.catch`에서 재시도/에러 배너 노출, 빈 안내 문구는 master/worker 분기.

#### #55 사용량 패널이 초기 로드 창/영구 실패 시 아무 표시 없이 비어 있고 나중에 튀어들어옴
- **렌즈**: state-coverage · **심각도**: low · **공수**: S
- **증거**: `UsagePanel.tsx:46-53` (usage null이면 return null); `App.tsx:79-86` (usage.get `.catch` → 8초 후 재시도만, 에러 미표시)
- **상세**: 첫 usage.get 응답 전에는 좌하단 게이지 영역이 비어 있다가 데이터 도착 시 미터 3개가 갑자기 나타나 레이아웃이 밀린다. 폴링이 지속 실패하면 사용량 표시가 조용히 사라진 채 남는다(예산 가드가 없는 앱에서 지출 가시성 상실).
- **제안**: 미로드 시 스켈레톤 자리표시로 pop-in을 없애고, 지속 실패 시 '사용량 불러오기 실패' 힌트를 노출한다.

#### #56 신규 설치 첫 화면부터 사이드바에 대형 사용액(Weekly $2,522.79)이 설명 없이 노출
- **렌즈**: pixel-pass · **심각도**: low · **공수**: S
- **증거**: 스크린샷 b-01, b-04 (좌하단 usage 블록); `manifest.md` — "usage panel numbers are real (global ccusage), even in the fresh Pass B home"
- **상세**: usage 패널이 계정 전역 ccusage 수치를 보여주기 때문에, 방금 설치해 아무것도 안 한 상태에서도 'Session·5h $157 / Weekly $2,522'가 표시된다. 출처(이 앱 밖의 Claude 사용 포함) 표기가 없어 '이 앱이 벌써 과금했다'는 오해를 부를 수 있다.
- **제안**: 패널 제목을 'Claude usage (account-wide)'로 명시하고 info 툴팁으로 ccusage 출처를 설명한다.

---

### 테마 3 — 파괴적 액션 가드: 확인·이탈 경고 부재

세션/워커 삭제에는 확인 다이얼로그가 있는데, 같은 무게의 다른 파괴적 액션들이 무확인·무경고로 실행되는 일관성 결함.

#### #18 Settings에서 미저장 변경이 있는 채로 닫으면 경고 없이 변경이 버려짐
- **렌즈**: interaction-feedback · **심각도**: medium · **공수**: S
- **증거**: `SettingsPage.tsx:41` (dirty 계산), `:67-69` (무가드 onClose → `App.tsx:187` navigate), `:342-346` (수동 Save 모델)
- **상세**: dirty는 Save 버튼 활성화에만 쓰이고, 헤더 X·사이드바 이동으로 페이지를 벗어날 때는 dirty여도 경고 없이 로컬 폼 상태가 소멸한다. 명시적 Save 모델(자동 저장 아님)인데 이탈 가드가 없다.
- **제안**: dirty 상태에서 닫기/이탈 시 '저장 안 된 변경이 있어요 — 저장/버리기/취소' 확인을 띄우거나 blur 자동 저장으로 전환한다.

#### #19 repo 등록 해제가 확인 없이 hover 아이콘 원클릭으로 실행되고 성공 피드백도 없음
- **렌즈**: interaction-feedback · **심각도**: medium · **공수**: S
- **증거**: `RepoTree.tsx:129-133` (확인 없는 onRemoveRepo); `App.tsx:596-599` (확인·성공 토스트 없음) vs `Sessions.tsx:318-324`·`RepoTree.tsx:196-202` (세션/워커 삭제는 확인 다이얼로그)
- **상세**: 그룹 헤더 휴지통 버튼이 repos.remove를 즉시 실행한다(DB 행만 삭제라 재등록 가능하지만, 소속 워커들이 'Other (unregistered)' 그룹으로 튀는 큰 변화가 즉시 발생). 등록은 성공 토스트가 있는데 제거는 없고, hover에서만 나타나는 '+'(워커 추가) 바로 옆이라 오클릭 가능성도 높다.
- **제안**: 세션/워커 삭제와 동일한 확인 다이얼로그(등록 해제일 뿐 파일은 남는다는 설명 포함)를 붙이고 성공 토스트를 추가한다.

#### #20 자동화 규칙 삭제가 확인 없이 아이콘 원클릭으로 실행됨
- **렌즈**: interaction-feedback · **심각도**: medium · **공수**: S
- **증거**: `AutomationPage.tsx:98` (onDelete 직접 호출); `App.tsx:955` (확인 없이 request); 스크린샷 a-10
- **상세**: 휴지통 버튼이 automation.delete를 즉시 호출한다. 공들여 만든 cron/slack 규칙(트리거+액션+모델 설정 전체)이 실수 클릭 한 번에 사라지고 undo도 없다. Run/Edit/Delete 아이콘이 같은 크기·톤으로 나란히 있어 오클릭 위험도 있다(세션 삭제는 이름을 보여주는 확인 모달이 이미 존재).
- **제안**: 삭제 전 확인 다이얼로그(규칙 이름 표시)를 추가하거나 최소한 삭제 성공 토스트+undo를 제공한다.

#### #44 저장 안 한(dirty) 파일 탭을 닫을 때 경고 없이 편집 내용이 버려짐
- **렌즈**: interaction-feedback · **심각도**: medium · **공수**: M
- **증거**: `TabBar.tsx:33` (dirty 점), `:35-37` (무확인 closeTab); `RookeryTab.tsx:40-48` (api.close() 무확인); `store/workspace.ts:105,122` (closeTab_에 가드 없음); `MonacoEditor.tsx:90-95` (외부 변경엔 명시적 'Reload (discard edits)' 확인)
- **상세**: Monaco 편집 탭은 dirty 상태를 추적해 점까지 표시하지만, 탭의 X 버튼(레거시 TabBar·dockview RookeryTab 모두)은 확인 없이 closeTab을 호출해 미저장 편집이 즉시 소실된다. 버퍼가 컴포넌트 로컬 상태뿐이라 복구 불가. 외부 변경에는 명시적 확인을 요구하면서 사용자가 직접 닫을 때는 같은 데이터 손실을 무경고로 허용하는 비일관성.
- **제안**: dirty 탭 닫기 시 '저장 안 함/저장/취소' 확인 다이얼로그를 띄우거나, 닫기 직전 자동 저장을 수행한다.

---

### 테마 4 — 발견성·내비게이션 (IA)

핵심 기능이 hover/우클릭 뒤에 숨어 있고, 위치 단서(활성 하이라이트·백링크·구분 라벨)가 끊기는 문제군.

#### #3 워커 스폰(WorkerSpawnModal) 진입점이 hover 전용 '+' 아이콘 하나 — 발견 불가 + 키보드 도달 불가
- **렌즈**: ia-navigation + a11y-keyboard + pixel-pass (3개 렌즈 병합) · **심각도**: high · **공수**: S
- **증거**: `RepoTree.tsx:124-127` (addWorker `hidden … group-hover:flex`), `:130` (removeRepo 동일); `App.tsx:602,1119-1130` (onNewSub가 유일한 오픈 경로); `i18n/en/app.ts:28` (emptyRepoHint가 '+'를 언급 안 함); `manifest.md:49` "NOT captured: WorkerSpawnModal (no entry point found in UI during capture)"; 스크린샷 a-01, a-17, b-05
- **상세**: GUI에서 워커를 직접 스폰하는 유일한 경로는 Repos 탭 레포 그룹 헤더에 hover했을 때만 나타나는 '+' 아이콘이다. `hidden`(display:none)이라 Tab 순서에서 완전히 빠져 **키보드 사용자는 도달 자체가 불가능**하고(group-focus-within 대체 없음, 같은 파일 Sessions.tsx:227은 이미 보정 패턴 보유), 스크린샷 캡처 담당자도 진입점을 찾지 못해 모달을 캡처하지 못했다. 빈 상태 문구(app.emptyRepoHint·repoTree.emptyState)도 이 버튼의 존재를 언급하지 않아, 브랜치/모델/티켓까지 지정할 수 있는 리치한 스폰 모달이 보이지 않는 기능이 된다. repo 제거 휴지통 버튼도 동일 패턴이다.
- **제안**: '+'를 상시 노출(저opacity → hover/focus 강조)하거나 Repos 사이드바에 'New worker' 상설 버튼을 배치하고, `group-focus-within:flex`를 추가해 키보드 포커스 시에도 드러나게 한다. repo 우클릭 메뉴에 'Spawn worker…' 항목과 빈 상태 문구 안내도 추가한다.

#### #21 세션 소스 필터가 현재 보고 있는 세션을 목록에서 숨겨 위치 하이라이트가 사라짐
- **렌즈**: ia-navigation · **심각도**: medium · **공수**: S
- **증거**: `Sessions.tsx:170-185` (visible 계산에 activeId 예외 없음); `store/store.ts:212` (기본 filter 'ui'); `App.tsx:958` (AutomationPage가 필터 변경); 스크린샷 a-20, a-22, a-23
- **상세**: 활성 세션이 현재 소스 필터(UI/Slack/Automation)와 다르면 목록에서 아예 사라진다. a-20/a-22에서 UI 세션을 보는 동안 필터가 Slack이라 사이드바 어디에도 활성 표시가 없다. 필터는 스토어에 남는 상태라 사용자가 눈치채지 못한 채 위치 단서를 잃고, 새 세션 생성 직후에도 다른 필터가 켜져 있으면 방금 만든 세션이 안 보일 수 있다.
- **제안**: 활성 세션은 필터와 무관하게 항상 목록에 포함(구분 표시)하거나, 세션 선택/생성 시 해당 소스 칩으로 필터를 자동 전환한다.

#### #22 Automation 진입 버튼이 Sessions 탭 사이드바에서만 보임
- **렌즈**: ia-navigation · **심각도**: medium · **공수**: S
- **증거**: `App.tsx:840-856` (`{!showRepos && …}` 블록 안의 New session/Automation 버튼 — overlay:"automation" 유일 트리거); Settings/재시작 버튼은 863-883행의 공통 영역; 스크린샷 a-01 vs a-05
- **상세**: 'New session'과 'Automation' 버튼이 `!showRepos` 조건으로 렌더되어 Repos 탭에서는 사라진다. Settings는 하단 기어로 어느 뷰에서든 접근되는데 Automation은 먼저 Sessions 탭으로 전환해야만 진입할 수 있어, 최상위 기능의 진입 가능성이 무관한 탭 상태에 좌우된다.
- **제안**: Automation 버튼을 조건 블록 밖 공통 영역(하단 상태줄 옆 또는 탭 행 아래)에 상설 배치한다.

#### #23 턴 진행 중 composer에 텍스트를 입력하면 Stop 버튼이 사라져 중단 수단이 없어짐
- **렌즈**: interaction-feedback · **심각도**: medium · **공수**: S
- **증거**: `Composer.tsx:237-246` (`busy && !text.trim()` 조건, 명시적 주석 존재); 스크린샷 a-27
- **상세**: Stop 버튼은 busy이고 입력이 비어 있을 때만 렌더되고, 한 글자라도 입력하면 Send로 바뀐다. 폭주하는 턴을 멈추려던 사용자가 후속 지시를 쓰다가 마음을 바꾸면 초안을 지워야만 Stop이 다시 나타난다. 헤더 등 다른 곳에 마스터 턴 중단 수단이 없어 이 순간 UI 전체에서 '중단' affordance가 0이 된다.
- **제안**: 입력 유무와 무관하게 busy 동안 Stop을 Send 옆에 병행 노출하거나, 헤더의 Working 칩에 중단 버튼을 추가한다.

#### #45 세션/워커 핵심 액션(rename·fork·stop·archive·delete)이 우클릭 전용 — 시각적 단서도 키보드 진입점도 없음
- **렌즈**: interaction-feedback + ia-navigation + a11y-keyboard (3개 렌즈 병합) · **심각도**: medium · **공수**: M
- **증거**: `Sessions.tsx:211` (onContextMenu 전용), `:226-247` (hover는 Pin/Delete만), `:304-316` (메뉴에만 Rename/Fork/Archive); `RepoTree.tsx:80,180-193` (워커 행 hover 액션 0, 메뉴 전용, keydown 없음); `i18n/ko/app.ts:26` ('diff/discard만 가능' 안내); 스크린샷 a-01, a-17
- **상세**: 세션 행과 워커 행의 컨텍스트 메뉴는 우클릭으로만 열리고 '⋯' 같은 가시 affordance가 없다. 세션 행은 hover 시 pin/삭제만 노출되고 워커 행은 hover 액션조차 없다. macOS 키보드에는 컨텍스트 메뉴 키가 없어(Shift+F10 미지원) 키보드만으로는 사실상 이 메뉴를 열 수 없다. 특히 orphaned 워커의 composer 플레이스홀더가 'diff/discard만 가능'이라 안내하지만 그 discard(Delete…)가 숨은 우클릭 메뉴에만 있어, 안내된 액션을 화면에서 찾을 수 없는 dead zone이 생긴다. (마스터 턴 중단용 Stop은 composer에 별도 존재 — 여기서 문제는 fleet 수준 Stop/Fork/Archive/Rename.)
- **제안**: 행 hover/focus 시 '⋯' 오버플로 버튼으로 동일 메뉴를 좌클릭/Enter로 열 수 있게 하고(기존 ContextMenu 재사용), 행 onKeyDown에서 메뉴 키를 처리한다. 실행 중 워커 행에는 Stop 아이콘, orphaned 워커 헤더에는 diff/discard 직접 버튼을 노출한다.

#### #46 세션·워커 기본 이름이 폴더/레포명으로 떨어져 목록이 동일 라벨의 벽이 됨
- **렌즈**: pixel-pass · **심각도**: medium · **공수**: M
- **증거**: 스크린샷 a-13, a-15 (사이드바 'clover-space' ×6), a-01 ('banking' ×3, 'admin-gateway' ×2), a-26 (헤더 'clover-space #395061'); `Sessions.tsx`의 `label || baseName(cwd) || id` 폴백
- **상세**: 제목 없는 세션은 cwd 폴더명, 워커는 레포명이 라벨로 쓰여 동일 라벨이 연달아 나열된다. 툴팁/경로/미리보기 등 구분 보조 정보가 없어 어떤 항목을 클릭해야 원하는 대화가 나오는지 알 수 없다.
- **제안**: 첫 user 메시지 요약으로 자동 제목을 채우고, 폴더명 fallback일 때는 마지막 활동 시각·미리보기 한 줄을 보조 텍스트로 붙인다.

#### #47 세션↔워커 교차 탐색이 spawn 카드 칩에만 의존 — 워커→모세션 역링크도 없음
- **렌즈**: ia-navigation · **심각도**: medium · **공수**: M
- **증거**: `lib/tool-worker.ts:5-9` (spawn_worker 결과 문자열만 매칭); `ToolBlock.tsx:68-70`; `MessageList.tsx:87-96` (라이브 전용 worker 마커); `store/reduce.ts:17` (FleetRow에 세션 필드 없음); `WorkspaceHeaders.tsx:39-67` (역링크 부재)
- **상세**: 마스터 대화에서 워커로 점프하는 경로는 spawn_worker 툴 카드의 'View worker' 칩과 라이브 전용 마커뿐이다. send_worker/get_worker_status/view_worker_diff 카드에는 링크가 없어 오래된 세션에서 특정 워커를 보려면 spawn 카드까지 스크롤하거나 Repos 탭에서 라벨을 눈으로 대조해야 한다. 반대로 워커 헤더에는 스폰한 세션으로 돌아가는 링크가 없다.
- **제안**: 워커 id가 등장하는 다른 fleet 툴 카드에도 'View worker' 칩을 부착(입력 JSON의 id 파싱)하고, 장기적으로 워커 헤더에 '스폰한 세션' 백링크를 노출한다.

#### #48 dock 모드에서 Files/Git/Terminal/Claude Agent 패널을 닫거나 숨길 방법이 전혀 없음 (레거시 토글 대비 회귀)
- **렌즈**: ia-navigation · **심각도**: medium · **공수**: M
- **증거**: `RookeryTab.tsx:35` (closable = editor 전용); `WorkspaceHeaders.tsx:32-33` (dock 모드에서 토글 숨김); `WorkspaceDock.tsx:118-121` (conversation 재추가); 스크린샷 a-01
- **상세**: editor 탭에만 close 버튼이 있고 고정 패널은 닫기 불가, conversation 패널은 닫혀도 자동 재추가된다. 레거시 레이아웃의 터미널/우측 패널 토글은 dock 모드에서 숨겨져, 대화에 집중하고 싶어도 사시(sash)를 끌어 최소 폭으로 줄이는 것 외에 수단이 없다.
- **제안**: 고정 패널에도 close(=hide)를 허용하고 헤더에 패널 표시/숨김 토글(또는 View 메뉴)을 복원한다. 최소한 터미널·우측 그룹 접기 토글은 dock 모드에서도 유지한다.

#### #57 dock 레이아웃이 페이지별로 저장되는데 초기화·기본값 지정 수단이 없음
- **렌즈**: ia-navigation · **심각도**: low · **공수**: S
- **증거**: `WorkspaceDock.tsx:105-114` (saved 복원 or seed만 존재); `store/layout.ts:8,33-35` (byPage; clear_ 호출처는 App.tsx:485,498 삭제 경로뿐); `workspace/default-template.ts:14-25`
- **상세**: 레이아웃은 페이지 키별로 저장·복원되고 새 페이지는 하드코딩된 기본 템플릿으로 시작한다. 커스텀 배치는 다음 세션/워커에 적용되지 않아 매번 재배치해야 하고, 드래그 실수로 망가뜨려도 '기본 레이아웃으로 리셋' UI가 없다(localStorage 직접 삭제 외 복구 불가).
- **제안**: 헤더 또는 패널 탭 우클릭에 'Reset layout' 액션(clear_ 후 재시드)을 추가하고, 선택적으로 '현재 레이아웃을 기본으로 저장'을 둔다.

#### #58 레포 0개일 때 New Session의 레포 피커 영역이 통째로 사라져 '레포 등록' 유도가 없음
- **렌즈**: pixel-pass · **심각도**: low · **공수**: S
- **증거**: `NewSessionPage.tsx:103-105` (`repos.length > 0` 게이트); 스크린샷 b-04 (composer 아래 공백)
- **상세**: 신규 설치 직후 New Session 페이지는 composer 아래가 빈 공간이다. 레포 등록이 워커 활용의 전제인데 이 화면에서는 그 존재를 알 수 없고 Repos 탭으로 우연히 이동해야 발견한다.
- **제안**: repos가 비었을 때 같은 자리에 '아직 등록된 레포가 없어요 — 레포를 등록하면 워커가 그 안에서 작업해요 [레포 등록…]' empty-state 카드를 렌더링한다.

#### #59 헤더의 open-in-app 스플릿 버튼이 24px 앱 아이콘+쉐브론만으로 노출되어 정체를 알 수 없음
- **렌즈**: pixel-pass · **심각도**: low · **공수**: S
- **증거**: `OpenInAppMenu.tsx:60-77` (w-6 아이콘 버튼 + w-[18px] 쉐브론, title/aria-label만); 스크린샷 a-01, a-06 우상단
- **상세**: 세션/워커 헤더 우측에 마지막 선택 앱 아이콘(iTerm이면 '$|' 글리프)과 11px 쉐브론이 붙은 초소형 스플릿 버튼이 있다. 라벨이 없어 메트릭스 행에 낀 정체불명의 글리프처럼 보이고, '작업 폴더를 외부 앱으로 연다'는 기능은 hover 툴팁까지 가야만 알 수 있다.
- **제안**: 'Open in ▾' 짧은 텍스트 라벨을 붙이거나 최소한 외부-링크 화살표 오버레이를 추가한다.

---

### 테마 5 — 키보드 접근성·포커스 관리

공용 훅(useFocusTrap/useModalKeys)과 보정 패턴(group-focus-within)이 이미 존재하는데 일부 컴포넌트만 누락된 케이스가 대부분 — 기존 패턴 복제로 해결된다.

#### #24 탭/터미널 닫기(X) 버튼이 hover에서만 보여 키보드 포커스 시 완전히 비가시
- **렌즈**: interaction-feedback + a11y-keyboard (병합) · **심각도**: medium · **공수**: S
- **증거**: `TerminalPanel.tsx:46`, `TabBar.tsx:36`, `RookeryTab.tsx:45` (`opacity-0 … group-hover:opacity-100`만, focus reveal 없음) vs `Sessions.tsx:227` (`group-focus-within:opacity-100` 보정 사례); `globals.css:148` (전역 focus-visible 아웃라인도 opacity-0에 함께 투명화)
- **상세**: 닫기 버튼들이 Tab 순서에는 남아 있어 포커스는 가지만, opacity:0이 요소 전체(코랄 focus 아웃라인 포함)를 투명하게 만들어 키보드 사용자는 어떤 요소에 포커스가 있는지 전혀 알 수 없고 보이지 않는 채 활성화된다.
- **제안**: `group-focus-within:opacity-100 focus-visible:opacity-100`을 추가한다 (Sessions 행 액션과 동일한 처리).

#### #25 첫 실행 OnboardingModal이 앱의 모달 a11y 계약(focus trap·Escape·role=dialog·autofocus)을 전혀 따르지 않음
- **렌즈**: a11y-keyboard · **심각도**: medium · **공수**: S
- **증거**: `OnboardingModal.tsx:1-3` (훅 미import), `:13` (root div에 role/aria-modal 없음), `:40-48` (autofocus·키 핸들러 없음); 대조군 `RepoModal.tsx:26-37`, `RestartDaemonDialog.tsx:13-27`; 스크린샷 b-02
- **상세**: 다른 모든 다이얼로그는 useFocusTrap+useModalKeys+role=dialog+aria-modal+autoFocus를 일관되게 쓰는데, 신규 사용자가 처음 만나는 온보딩 마법사만 이를 전부 빠뜨렸다: 포커스가 모달로 이동하지 않고, Tab이 배경으로 새며, Escape/Enter가 동작하지 않고, 스크린리더가 모달로 인식하지 못한다.
- **제안**: panelRef + useFocusTrap, useModalKeys(Enter=Next/완료, Escape=Skip), `role="dialog" aria-modal="true" aria-label`, Next/Get Started에 autoFocus를 추가해 나머지 모달과 동일한 패턴으로 맞춘다.

#### #26 차단형 첫 실행 DataConsentModal에 dialog role·포커스 이동·트랩이 없음
- **렌즈**: a11y-keyboard · **심각도**: medium · **공수**: S
- **증거**: `DataConsentModal.tsx:16-29` (fixed inset-0 div에 role/aria-modal 없음, Accept 버튼 autoFocus 없음, 포커스 훅 미사용); 스크린샷 b-01
- **상세**: 앱을 여는 최초의 차단 게이트인데 role=dialog/aria-modal이 없고, 열릴 때 'Accept & Continue'로 포커스가 이동하지 않으며 포커스 트랩도 없다. 스크린리더 사용자는 모달이라는 안내를 받지 못하고 배경 요소를 계속 탐색할 수 있다. (Accept-only 특성상 Escape 차단은 의도로 유지 가능.)
- **제안**: 패널에 `role="dialog" aria-modal="true" aria-labelledby`를 부여하고, Accept 버튼 autoFocus + useFocusTrap을 적용한다(Escape는 무동작 유지).

#### #27 WorkerSpawnModal의 GitHub/Linear 검색 결과 드롭다운이 키보드로 조작 불가
- **렌즈**: a11y-keyboard · **심각도**: medium · **공수**: S
- **증거**: `WorkerSpawnModal.tsx:173-176` (onBlur→setFocused(false), 입력에 onKeyDown 없음, `focused && …`로만 표시), `:181-191` (결과 버튼 목록); 대조군 `PromptEditor.tsx:116-121` (방향키+Enter 처리)
- **상세**: 소스 검색 결과가 `focused &&` 조건으로만 렌더되고 blur 시 즉시 사라져, Tab으로 결과 버튼에 도달하기 전에 목록이 닫힌다. 방향키/Enter 핸들러도 없어 결과 선택이 사실상 마우스 전용이다(같은 앱의 슬래시 팝업은 방향키+Enter 지원).
- **제안**: 검색 입력에 ArrowDown/Up 하이라이트 이동 + Enter 선택 키 핸들러를 추가하고, 포커스가 목록 내부로 갈 때는 blur로 닫지 않는다.

#### #60 CheckpointMenu·OpenInAppMenu 팝업이 열릴 때 첫 항목 포커스·방향키 로빙이 없음
- **렌즈**: a11y-keyboard · **심각도**: low · **공수**: S
- **증거**: `CheckpointMenu.tsx:41-68`, `OpenInAppMenu.tsx:79-98` (role=menu/menuitem인데 초기 포커스·방향키 없음, Escape만); 대조군 `ContextMenu.tsx:19` (첫 항목 focus), `:22-30` (방향키 로빙)
- **상세**: ContextMenu는 열릴 때 첫 menuitem 포커스 + ArrowUp/Down 로빙 + Enter를 지원하는데, 두 드롭다운은 같은 role을 쓰면서도 이를 빠뜨려 ARIA 메뉴 관례와 어긋난다.
- **제안**: 열릴 때 첫 menuitem focus() + ArrowUp/Down 로빙 핸들러 추가 (ContextMenu 로직 재사용).

#### #61 ResourceMonitor 팝오버가 Escape로 닫히지 않고 포커스 관리가 없음
- **렌즈**: a11y-keyboard · **심각도**: low · **공수**: S
- **증거**: `ResourceMonitor.tsx:82-104` (바깥 클릭 close만); 대조군 `OpenInAppMenu.tsx:34-39` (Escape 닫기)
- **상세**: 리소스 모니터 팝오버는 바깥 클릭으로만 닫히고 Escape 키 핸들러가 없으며, 열릴 때 내부로 포커스가 이동하지도 않는다. 다른 오버레이와 동작이 일관되지 않는다.
- **제안**: open일 때 Escape로 close하는 keydown 리스너를 추가하고, 열릴 때 내부(Refresh 버튼)로 포커스를 이동시킨다.

---

### 테마 6 — Dock 워크스페이스 크롬

dockable 전환(기본 ON) 과정에서 남은 레거시 잔재와 신규 회귀들.

#### #28 file 탭과 diff 탭이 같은 라벨('CLAUDE.md')로 나란히 열려 12px 아이콘으로만 구분됨
- **렌즈**: visual-consistency + ia-navigation + copy-i18n + pixel-pass (4개 렌즈 병합) · **심각도**: medium · **공수**: S
- **증거**: `store/workspace.ts:34,42` (openFile/openDiff 모두 title=basename(path)); `RookeryTab.tsx:20,38-39` (title 속성 없는 truncate span, FileText vs GitCompare 아이콘만); `TabBar.tsx` 동일; 스크린샷 a-22, a-23, a-30; `manifest.md:51` 캡처 노트
- **상세**: Git 변경을 클릭해 연 diff 탭과 Files에서 연 편집 탭이 같은 라벨로 dock 스트립에 나란히 생긴다('Master | CLAUDE.md | CLAUDE.md'). 구분 수단이 12px 회색 아이콘의 미세한 차이뿐이고 tooltip도 없어, 어느 탭이 편집 가능한 원본이고 어느 쪽이 read-only diff인지 클릭 전엔 알 수 없다. diff/file 조합은 흔한 워크플로라 탭이 늘수록 혼란이 커진다.
- **제안**: diff 탭 title을 `${basename} (diff)` 또는 `${basename} ⇄ HEAD`로 구분하고, 라벨 span에 전체 경로+종류 tooltip을 추가한다. commit 탭처럼 접두/접미 규칙을 정한다.

#### #29 dockview 패널 타이틀이 생성 시점에 고정·persist되어 ko에서 영어 크롬이 남음
- **렌즈**: visual-consistency · **심각도**: medium · **공수**: S
- **증거**: `WorkspaceDock.tsx:30-38` (titleFor — addPanel 시 1회만 t()), `:46-53` (addPanel title), `:108-109` (saved fromJSON 복원); `i18n/ko/app.ts:20-21` ('마스터/터미널 (하단 패널)' 번역 존재); 스크린샷 a-30 (영어 dock 탭 + 한국어 본문)
- **상세**: 탭 타이틀이 addPanel 호출 시 한 번만 번역되고 dockview 레이아웃 JSON에 그대로 persist된다. 언어를 ko로 바꾸거나 ko로 재실행해도 저장된 레이아웃이 복원되면서 'Master / Files / Git / Terminal (bottom panel)'이 영어로 남는다. 런타임 언어 전환이 특징인 i18n 구조에서 가장 눈에 띄는 크롬이 전환에서 빠져 있다.
- **제안**: RookeryTab이 api.title 대신 params.kind 기반으로 t()를 직접 렌더하거나, locale 변경/마운트 시 fixed 패널들의 setTitle을 재실행한다.

#### #30 터미널을 열지 않아도 하단 Terminal 패널이 ~220px 높이를 항상 점유
- **렌즈**: pixel-pass · **심각도**: medium · **공수**: S
- **증거**: `WorkspaceDock.tsx:43-44` (terminal initialHeight 220); `TerminalPanel.tsx` (힌트 한 줄만 중앙 렌더); 스크린샷 a-01, a-06, a-20 (하단 공백)
- **상세**: 모든 세션/워커 페이지에서 하단 dock 패널이 기본으로 펼쳐진 채 'Press + to open a terminal…' 한 줄만 띄우고 나머지는 빈 영역이다. 대화 영역의 세로 공간을 상시 20% 이상 잠식하며, 열기 버튼 '+'는 좌상단 구석의 저대비 아이콘이라 힌트 문장과 시선 동선도 어긋난다.
- **제안**: 터미널 미사용 시 패널을 탭 스트립만 남기고 접힌 상태(~36px)로 시드하고, 탭/'+' 클릭 시 220px로 확장한다.

#### #49 dock 터미널: '(bottom panel)' 라벨 잔재 + 이중 탭바 + 빈 패널에서 수동 '+' 필요
- **렌즈**: visual-consistency ×2 + ia-navigation (3건 병합) · **심각도**: medium · **공수**: M
- **증거**: `WorkspaceDock.tsx:35` (`t("workspaceHeaders.terminalTitle")` 재사용); `i18n/en/workspaceHeaders.ts:4` ("Terminal (bottom panel)" — 원래 비-dock 헤더 토글 버튼의 툴팁용); `TerminalPanel.tsx:40-54` (내부 h-8 탭 스트립 + 빈 상태); `i18n/en/terminalPanel.ts:6` (빈 상태 힌트가 "…session's working folder"); `App.tsx:287-295` (레거시 자동 스폰) vs `:970-973` (dock에선 noop); 스크린샷 a-01, a-04, a-19
- **상세**: 세 가지가 겹친다. (1) dock 패널 제목이 헤더 토글 툴팁 문구를 재사용해 'Terminal (bottom panel)'로 장황하고, dockview에서는 패널을 어디로든 옮길 수 있어 라벨이 위치를 거짓말한다(옆 탭들은 'Files', 'Git' 한 단어). (2) dock 그룹 탭 바로 아래 TerminalPanel 자체의 터미널 탭바(11px mono, bg-raised 활성)가 또 렌더되어 탭바가 두 줄로 중첩되고 스타일 문법(11.5px sans + coral 밑줄 vs mono pill)도 다르다 — 터미널 0개일 땐 '+'만 있는 빈 스트립이 남는다. (3) 레거시 모드는 터미널 토글 시 셸을 자동 스폰했지만 dock 모드는 항상 보이는 패널이 빈 상태로 남아 좌측의 작은 '+'를 눌러야 하고, 빈 상태 힌트는 워커 페이지에서도 워크트리에서 열린다는 사실을 알려주지 않는다.
- **제안**: 탭 타이틀용 별도 키(workspaceHeaders.terminalTab = "Terminal"/"터미널")를 추가하고, dock 모드에서 내부 탭바를 dock 탭과 동일 문법으로 맞추거나 터미널 0~1개일 때 '+'만 있는 우측 정렬 액션으로 축소한다. 패널이 처음 보일 때(또는 빈 상태 클릭 시) 셸 하나를 자동 스폰하고, 빈 상태 힌트는 페이지 종류별로 '워커 워크트리에서 시작' 문구로 분기한다.

---

### 테마 7 — 용어·카피·로컬라이제이션

프로젝트 자체 용어 규칙(AGENTS.md: fleet 일꾼=Worker, agent=네이티브 중첩 전용)과 i18n 불변식('모든 사용자 노출 문자열은 i18n 경유')을 어기는 카피들.

#### #31 동일한 '워커'를 화면마다 worker/agent/Claude Agent로 뒤섞어 부름
- **렌즈**: copy-i18n + pixel-pass (병합) · **심각도**: medium · **공수**: S
- **증거**: en/ko `repoTree.ts` emptyState ('spawning agents' / '에이전트를 띄울') vs `app.ts` emptyRepoHint (spawn a new one = worker) — 스크린샷 b-05/b-07에서 한 화면에 동시 노출; `app.ts` agentEndedReadonly ('Agent ended / 종료된 에이전트' — kind="worker" 패널에 사용); `interactionCard.ts` askPrompt·`assistantMessage.ts` copyMessage ('agent/에이전트')
- **상세**: 같은 화면에서 좌측 사이드바는 'start spawning agents there', 중앙 빈 상태는 'ask the master to spawn a new one'(worker)이라 한 개념을 두 단어로 부른다. 종료된 워커 메시지도 워커를 'Agent'로 부르고, 우측 패널에는 'Claude Agent' 탭이 실제로 존재해(→#32) 첫 사용자가 Master·Worker·Agent가 다른 것인지 같은 것인지 알 수 없다. 프로젝트 용어 규칙 위반이며 ko/en 모두 해당된다.
- **제안**: fleet 일꾼은 en 'worker' / ko '워커'로 통일하고 'agent/에이전트'는 중첩 서브에이전트에만 쓴다 — repoTree.emptyState·app.agentEndedReadonly를 '워커' 기준으로 재작성.

#### #32 우측 네스티드 패널을 Claude Agent / Worker panel / Nested agents 세 가지로 다르게 부르고, dock 빈 상태는 i18n 우회 하드코딩
- **렌즈**: ia-navigation + copy-i18n (병합) · **심각도**: medium · **공수**: S
- **증거**: `i18n/rightSidebar.ts` segmentWorker("Claude Agent") & noNestedAgents(미사용 키); `workspaceHeaders.ts` rightPanelTitle("Worker panel"); `nestedAgents.ts` title("Nested agents"); `workspace/panels.tsx:30` (영어 'No nested agents.' 하드코딩 — 같은 상태를 올바르게 처리하는 `RightSidebar.tsx:112`와 대조); 스크린샷 a-01 (탭 'Claude Agent' + 'No nested agents.')
- **상세**: 한 패널인데 세그먼트 탭은 'Claude Agent', 여는 버튼 툴팁은 'Worker panel', 패널 제목은 'Nested agents', 빈 상태는 'nested agents가 없다'로 나온다. 헤더 eyebrow도 'Worker'인 화면에서 'Claude Agent'가 무엇인지 라벨만으로 알 수 없다. 게다가 dock 패널의 빈 상태 문구는 panels.tsx에 영어로 하드코딩되어 한국어 로케일에서도 영어로 나온다(준비된 i18n 키 미사용 — dockable 패널 복제 과정의 회귀).
- **제안**: 탭/툴팁/제목/빈 상태를 'Nested agents / 중첩 에이전트'로 통일하고, 하드코딩 문구를 `t("rightSidebar.noNestedAgents")`로 교체한다.

#### #33 effort 옵션에 기계 토큰 'xhigh'가 그대로 노출되고 ko에서도 미번역
- **렌즈**: copy-i18n · **심각도**: medium · **공수**: S
- **증거**: `lib/models.ts:12` (EFFORTS=['low','medium','high','xhigh','max'], label 매핑 없음 — MODELS는 label 보유); `SettingsPage.tsx:142,260` (option 라벨 {ef}); `workerSpawnModal.ts` effortOption("effort: {effort}"); 스크린샷 a-12, a-31 (effort='xhigh')
- **상세**: effort 선택지가 raw enum 값을 그대로 출력해 'xhigh' 같은 비자연어 토큰이 보이고, 이 값들과 'effort' 라벨 자체가 ko 로케일에서도 영어로 남는다.
- **제안**: effort 값에 표시용 라벨 매핑(xhigh→'Extra high / 매우 높음')을 두고 ko/en 각각 번역한다.

#### #34 ko 문자열 안에 영어 제품 용어가 섞여 들어감 (New Session, effort, 네임)
- **렌즈**: copy-i18n · **심각도**: medium · **공수**: S
- **증거**: `i18n/ko/settings.ts` defaultFolderDesc('New Session에서…' — 실제 버튼은 '새 세션'), workerModelEffort('워커 기본 모델 / effort'), botName('에이전트 네임'); 스크린샷 a-31
- **상세**: 한국어 카피 안에 영어 원문이 박혀 로컬라이즈 완성도가 떨어진다. defaultFolderDesc는 실제 내비 명칭('새 세션')과도 어긋나고, '에이전트 네임'은 '폴더 경로'·'작업 디렉토리' 등 번역된 라벨들과 톤이 다르다.
- **제안**: 'New Session'→'새 세션', 'effort'는 번역 또는 전역 일관 처리, '에이전트 네임'→'에이전트 이름'.

#### #35 영어 UI인데 Git History의 상대 시각이 한국어('4일 전', '7주 전')로 표시됨
- **렌즈**: pixel-pass · **심각도**: medium · **공수**: S
- **증거**: `apps/desktop/src/main/workspace-manager.ts:329` (`git log --format=%cr` — OS/git locale 종속; 같은 파일 gitCommitFiles(:363)는 locale-독립 포맷 사용); renderer에 `lib/relative-time.ts` + i18n relativeTime 카탈로그 기보유; 스크린샷 a-23, a-24
- **상세**: %cr은 git/OS locale을 따르므로 앱 표시 언어(en)와 무관하게 한국어가 나온다. UI 전체는 영어인데 히스토리 시각만 '7주 전'이라 앱 언어를 en으로 강제한 사용자에게는 버그로 보인다.
- **제안**: %ct(unix time)로 받아 renderer의 relativeTime()+i18n 카탈로그로 포맷해 앱 locale과 일치시킨다.

#### #36 페이지 헤더 eyebrow의 클래스·언어 처리가 화면마다 다름 — ko에서 대소문자·언어 4조합
- **렌즈**: visual-consistency + copy-i18n + pixel-pass (3건 병합) · **심각도**: medium · **공수**: S
- **증거**: `SettingsPage.tsx:65`, `AutomationPage.tsx:61` (.eyebrow 클래스·t() 누락, 영어 하드코딩) vs `NewSessionPage.tsx:56` (클래스는 있으나 'New session' 하드코딩 + 로컬라이즈 제목 span 자체가 없음 — newSessionPage 카탈로그에 title 키 부재), `WorkspaceHeaders.tsx:48,78` (i18n 정상); `NestedAgents.tsx:17` (uppercase인데 클래스 없음); `globals.css:158` (:lang(ko) .eyebrow 규칙); 스크린샷 a-29, a-30, a-31, a-32
- **상세**: :lang(ko) .eyebrow 규칙은 한국어에서 uppercase/tracking을 중화하는 opt-in인데 적용이 들쭉날쭉해, ko 화면에서 같은 위치의 라벨이 'SETTINGS'(대문자·자간 유지) / 'AUTOMATION'(대문자) / 'New session'(영어 일반 케이스, 한국어 제목 없음) / '세션'(한글)의 4가지 조합으로 나온다. Settings/Automation은 영어 eyebrow+한글 제목 병기인데 New Session만 한국어가 아예 없다.
- **제안**: 누락된 곳(SettingsPage/AutomationPage/NestedAgents)에 .eyebrow 클래스를 추가하고 eyebrow·제목 문자열을 i18n 키로 통일한다. NewSessionPage에는 `t("newSessionPage.title")`('새 세션') 제목 span을 추가한다.

#### #50 워커 상태 태그: 8.5px 초소형 + 난해 약어(ORPH/PREP) + 미번역 + 트리·헤더 표기 불일치
- **렌즈**: visual-consistency + copy-i18n + pixel-pass (3건 병합) · **심각도**: medium · **공수**: M
- **증거**: `RepoTree.tsx:94` (statusTag `font-mono text-[8.5px]`, title 툴팁 없음) vs `StatusBadge.tsx:14,30` (text-[11px], raw {status} 렌더); `lib/status.ts:9-10` (TAG 맵: provisioning→PREP, running→RUN, orphaned→ORPH, failed/error→둘 다 ERR — 주석상 colorblind-safe 대체 채널); `MessageList.tsx:91`; 스크린샷 a-01 (트리 'ORPH' vs 헤더 'orphaned')
- **상세**: 사이드바 워커 행의 상태 태그가 헤더 StatusBadge의 77% 크기(8.5px)로 판독 한계이고, 라벨이 i18n을 거치지 않아 ko에서도 'ORPH'/'orphaned'가 영어로 노출된다. 'ORPH'/'PREP'는 툴팁도 없어 처음 보는 사용자가 해독할 수 없고, failed와 error가 둘 다 'ERR'로 뭉개지며, 같은 워커가 트리에선 'ORPH', 헤더에선 'orphaned'로 다르게 표기된다. 이 태그는 색맹 사용자를 위한 의도된 대체 채널(색 레일+dot 병행)인데 크기가 그 목적을 훼손한다. 상태는 fleet 제어 플레인의 1차 정보다.
- **제안**: 상태→라벨을 i18n 키(status.*)로 옮겨 ko/en 완전한 단어로 표기하고, 태그를 최소 10px로 올리거나 title 툴팁으로 전체 상태명('orphaned — 재시작으로 세션 유실')을 제공한다. 트리와 헤더가 같은 라벨 소스를 쓰도록 통일한다.

#### #51 자동화 규칙 카드가 Slack 채널·유저를 원시 ID(#C05ABJ86WBA, @U02QWK6NRKN)로 노출
- **렌즈**: pixel-pass · **심각도**: medium · **공수**: M
- **증거**: `AutomationPage.tsx:18-20` (trigger.channels/fromUsers 원시 ID 문자열 결합); 코드베이스 전체에 conversations.info/users.info 해석 로직 부재; 스크린샷 a-10, a-32
- **상세**: 규칙 요약줄이 사람이 읽을 수 없는 Slack 내부 ID를 그대로 보여준다. 규칙이 쌓이면 어떤 채널을 감시하는 규칙인지 카드만 봐서는 구분이 불가능하다.
- **제안**: 저장 시 또는 표시 시 conversations.info로 채널명·유저명을 해석해 캐시하고, 실패 시에만 ID를 폴백으로 쓴다.

#### #62 안내 문구의 동사(diff/discard, agents)가 실제 UI 라벨(Git 탭, Delete…, workers)과 어긋남
- **렌즈**: ia-navigation · **심각도**: low · **공수**: S
- **증거**: `i18n/en/app.ts:26` (sessionEndedRestart — 'only diff/discard available'); `i18n/en/repoTree.ts:6` (emptyState 'agents'), `:15` ('Delete…'); 스크린샷 a-01, b-05
- **상세**: orphaned 워커 composer의 'Session ended by restart — only diff/discard available'은 데몬 용어를 그대로 노출한다. UI에는 'discard' 라벨이 없고(컨텍스트 메뉴는 'Delete…'), 'diff'는 'Git' 탭 안의 Changes를 뜻하며, 'Session'도 워커 화면에서는 마스터 세션과 혼동된다.
- **제안**: placeholder를 '재시작으로 종료된 워커 — Git 탭에서 변경 확인, 우클릭 메뉴에서 삭제 가능'처럼 실제 UI 라벨로 다시 쓴다(agents→workers 통일은 #31).

#### #63 같은 개념을 'job/작업'과 'automation/자동화'로 혼용
- **렌즈**: copy-i18n · **심각도**: low · **공수**: S
- **증거**: `automationPage.ts` newJob("New job/새 작업")·empty("No scheduled jobs yet/예약된 작업이 없어요") vs `automationModal.ts` titleNew("New automation/새 자동화")·`automationPage.ts` title("Automation/자동화"); 스크린샷 a-11, a-32
- **상세**: 좌측 내비/페이지 제목/모달 제목은 'Automation/자동화'인데 생성 버튼과 빈 상태는 'job/작업'을 쓴다. 'New job'을 눌렀는데 열리는 폼 제목이 'New automation'이라 같은 것을 만드는지 확신하기 어렵다. ko/en 모두 동일.
- **제안**: 'automation/자동화' 기준으로 통일 (newJob→'New automation/새 자동화', empty→'자동화가 없어요').

#### #64 en 라벨 표기 비일관 — 'register'/'spawn' 소문자, 'effort' 케이싱, '— Model (default) —'
- **렌즈**: copy-i18n + pixel-pass (병합) · **심각도**: low · **공수**: S
- **증거**: `repoModal.ts` register("register") vs `common.ts` Save/Cancel; `workerSpawnModal.ts` spawn("spawn"); `automationForm.ts` 'Effort' vs `settings.ts`·`workerSpawnModal.ts` 'effort'; automationForm의 '— Model (default) —' 장식 대시; 도움말 소문자 시작; 스크린샷 b-06, a-12, a-11
- **상세**: 대부분의 공용 버튼은 Title Case인데 repo 등록 모달의 primary는 소문자 'register'(옆 'Cancel'과 나란히), 스폰 모달은 'spawn'이다. 'effort' 라벨도 화면마다 대소문자가 다르고, 기본 모델 표기는 장식 대시를 쓴다. 개별로는 사소하지만 폼 전반에서 반복되어 완성도가 낮아 보인다.
- **제안**: 버튼/라벨을 Title Case로 통일(Register/Spawn/Effort)하고, 기본값은 'Default (Claude Opus 4.8)'처럼 실제 값을 보여주는 라벨로 바꾼다.

#### #65 좌하단 daemon/slack 상태 접미사가 하드코딩 영어 (Settings와 불일치)
- **렌즈**: copy-i18n · **심각도**: low · **공수**: S
- **증거**: `App.tsx:865-872` (`daemon · ${s.daemon}`, `slack · ${s.slack}` 하드코딩, title 툴팁도 raw 영어) vs `settings.ts`의 slackUp/slackConnecting/slackError/slackOff/slackUnconfigured (기번역); 스크린샷 b-07
- **상세**: 상태 접미사('starting','down','unconfigured','connecting','error','off')가 i18n을 거치지 않아 ko에서도 'daemon · starting'처럼 영어로 노출된다. 같은 Slack 상태가 Settings에서는 이미 번역되어 있어 화면에 따라 영어/한국어로 다르게 보인다.
- **제안**: 상태 접미사를 i18n 키로 옮기고 Settings의 slack 상태 라벨과 동일 문구를 공유한다.

#### #66 ko 어조가 해요체(기본)와 합니다체 사이에서 흔들림
- **렌즈**: copy-i18n · **심각도**: low · **공수**: S
- **증거**: `ko/dataConsent.ts` body; `ko/settings.ts` claudeAuthDesc/claudeApiKeyActive; `ko/restartDaemonDialog.ts` body (한 문단 안에서 '…복원되지 않습니다'+'계속할까요?'); `ko/gitChanges.ts` revertDescUntracked/revertDescTracked (한 쌍 안에서 혼용); 스크린샷 b-01
- **상세**: 앱 전반의 기본 어조는 해요체인데 데이터 동의 모달·Claude 설정 섹션은 합니다체이고, 재시작 다이얼로그와 되돌리기 설명은 한 문단/한 쌍 안에서 두 어조를 섞는다.
- **제안**: ko 전역 어조를 해요체로 통일(권장)하거나 다이얼로그류만 합니다체로 통일하되, 문장 내 혼용은 제거한다.

#### #67 같은 'Working' 상태를 ko에서 '작업 중'과 '처리 중' 두 단어로 부름
- **렌즈**: copy-i18n · **심각도**: low · **공수**: S
- **증거**: `ko/sessions.ts` workingDot('작업 중'), `ko/workspaceHeaders.ts` working('작업 중') vs `ko/app.ts` busyAddable('처리 중…') — en은 셋 다 'Working'
- **상세**: 진행 중 상태를 가리키는 ko 단어가 갈려 같은 상태가 화면마다 다른 말로 보인다.
- **제안**: '작업 중'으로 통일 (busyAddable→'작업 중… (메시지 추가 가능)').

#### #68 ko '대기 중'이 Idle과 Queued 두 상태에 동시에 쓰여 모호
- **렌즈**: copy-i18n · **심각도**: low · **공수**: S
- **증거**: `ko/notify.ts` idle('대기 중 — 다음 지시를 입력하세요') vs `ko/conversation.ts` pendingBadge('대기 중') — en은 'Idle' vs 'Queued'
- **상세**: 유휴(완료 후 대기)와 전송 대기(아직 안 보낸 메시지)라는 다른 두 의미가 한국어로 같은 라벨이라 en 대비 정보가 손실된다.
- **제안**: pendingBadge ko를 '전송 대기' 또는 '대기열'로 바꾼다.

#### #69 repoModal 힌트 동어반복('path is the path to a git repo') + 소문자 플레이스홀더
- **렌즈**: copy-i18n · **심각도**: low · **공수**: S
- **증거**: `en/repoModal.ts` pathHint, namePlaceholder/pathPlaceholder/descPlaceholder("name"/"path"/"description"); 스크린샷 b-06
- **상세**: 힌트가 'path is the path to a git repo cloned locally.'로 동어반복이라 어색하고, 플레이스홀더가 필드 목적만 반복하는 소문자 단어라 같은 모달의 'Browse'/'Cancel'(Title Case)과 톤이 어긋난다.
- **제안**: 힌트를 'The local path to a cloned git repo — workers operate in its worktree.'처럼 다시 쓰고, 플레이스홀더는 예시 값('my-service', '/Users/you/project')으로 교체한다.

#### #70 CommitView 메타가 '1 files'로 표기 — 단수형 없음, 'Changed files 1' 어순도 어색
- **렌즈**: pixel-pass · **심각도**: low · **공수**: S
- **증거**: 스크린샷 a-24 ('1 files +69 -0', 'CHANGED FILES 1'); `i18n/en/commitView.ts:4-5` ({count} files 단일 폼), `CommitView.tsx:46,53`
- **상세**: 커밋 상세 헤더가 단복수 미처리로 '1 files'를 렌더하고, 섹션 제목도 숫자가 뒤에 붙는 어순이라 오타처럼 보인다.
- **제안**: count===1 분기('1 file') 추가, 섹션 제목은 'Changed files (1)' 형태로.

#### #71 Automation/Settings 헤더가 'AUTOMATION  Automation'으로 같은 단어를 두 번 표기
- **렌즈**: pixel-pass · **심각도**: low · **공수**: S
- **증거**: 스크린샷 a-10 ('AUTOMATION Automation'), a-12 ('SETTINGS Settings'); `AutomationPage.tsx`/`SettingsPage.tsx` (하드코딩 eyebrow + t(title) 병기)
- **상세**: 페이지 타입 eyebrow와 페이지 제목이 동일 단어라 중복 타이포그래피 실수처럼 보인다. SESSION/제목 조합에선 유효한 패턴이지만 제목=타입인 고정 페이지에선 eyebrow가 정보를 주지 않는다.
- **제안**: 제목이 타입과 동일한 페이지에선 eyebrow를 생략하거나 아이콘으로 대체한다.

---

### 테마 8 — 시각 일관성: 디자인 시스템 드리프트

공용 Button/Select/모달 클래스가 존재하는데 개별 화면이 raw 구현으로 우회한 케이스들. 대부분 공용 컴포넌트 교체로 끝나는 S 작업이다.

#### #37 Tooltip이 트리거 폭을 containing block으로 써서 한국어 라벨이 한 글자씩 세로로 꺾임
- **렌즈**: visual-consistency + pixel-pass (병합) · **심각도**: medium · **공수**: S
- **증거**: `Tooltip.tsx:19,22-28` (relative inline-flex 트리거 + absolute + whitespace-normal/break-words, w 미지정); 스크린샷 a-31 (좌하단 gear 위 '설/정' 세로 툴팁)
- **상세**: absolute 요소의 shrink-to-fit 가용 폭이 트리거 span(아이콘 버튼이면 ~24px) 기준이 되고 break-words가 CJK를 글자 단위로 꺾어, '설정' 같은 한국어 라벨이 '설/정' 두 줄 세로 텍스트로 렌더링된다(a-31에서 실관측). 영문은 단어 최소폭 덕에 멀쩡해 en 스크린샷만 보면 놓치는 ko 전용(기본 언어) 결함이다.
- **제안**: 툴팁에 `w-max + max-w-[220px]`를 함께 주거나(shrink-to-fit을 내용 기준으로), portal로 body에 띄워 containing block 제약을 제거한다.

#### #38 다이얼로그 긍정 액션의 시각 위계가 제각각 — primary coral / ghost / raw 빨강이 혼재
- **렌즈**: visual-consistency · **심각도**: medium · **공수**: S
- **증거**: `RestartDaemonDialog.tsx:32` (variant 없음 → ghost), `RunAutomationDialog.tsx:61`, `FileTree.tsx:239` vs `RepoModal.tsx:61`·`WorkerSpawnModal.tsx:211` (variant=primary); `ui/button.tsx:24` (defaultVariants variant:"ghost")
- **상세**: 확인 버튼이 variant 미지정으로 기본값 ghost가 되는 곳이 3곳 있다. ghost는 테두리조차 없어 바로 옆 Cancel(outline)보다 확인 버튼이 시각적으로 더 약해지는 위계 역전이 생긴다 — '데몬 재시작'처럼 무게 있는 액션이 텍스트 버튼처럼 보인다.
- **제안**: 다이얼로그 푸터 규칙을 'Cancel=outline, 확인=primary(파괴적이면 danger-solid)'로 고정하고 3곳에 variant="primary"를 명시한다.

#### #39 비활성 primary 버튼(opacity-40)이 여전히 '눌리는 컬러 버튼'처럼 보임
- **렌즈**: pixel-pass · **심각도**: medium · **공수**: S
- **증거**: `ui/button.tsx:7,11` (disabled:opacity-40만); 스크린샷 a-01 (orphaned composer의 send), a-27 (미선택 Submit), b-06 (빈 폼의 register)
- **상세**: 어두운 배경 위 coral accent 채움은 40% 불투명도여도 명확히 '컬러 버튼'으로 읽힌다. 종료된 orphaned 워커의 composer(입력 불가)에서 send가 컬러로 남아 있고, AskUserQuestion의 Submit은 옵션 선택 전에도 눌릴 것처럼 보인다. 눌러도 반응이 없어 '고장'으로 오해하기 쉽다.
- **제안**: disabled를 회색 채움(bg-raised + text-muted)으로 교체하거나 opacity를 0.25 이하로 낮추고, 종료된 세션 composer는 send/attach 자체를 숨긴다.

#### #40 데몬 재시작 중 좌하단 상태 푸터가 항목 중간에서 줄바꿈되어 깨져 보임
- **렌즈**: pixel-pass · **심각도**: medium · **공수**: S
- **증거**: 스크린샷 b-07 (크롭 확인: 'daemon ·' / 'starting' 2줄 + dot 부유, 'slack ·' / 'unconfigured' 동일); `App.tsx:864-871` (whitespace-nowrap 부재)
- **상세**: 상태 단어가 길어지면(starting, unconfigured) 푸터가 라벨-구분점-값을 두 줄로 쪼개고 상태 dot이 두 줄 사이 좌측에 뜬다. 재시작 같은 민감한 순간에 UI가 망가진 인상을 준다.
- **제안**: 각 상태 항목을 inline-flex + whitespace-nowrap으로 묶고, 공간 부족 시 truncate하거나 dot+툴팁만 남긴다.

#### #41 저장된 write-only 시크릿(Slack 토큰)이 빈 placeholder 필드로 보여 '설정 안 됨'처럼 읽힘
- **렌즈**: pixel-pass · **심각도**: medium · **공수**: S
- **증거**: 스크린샷 a-14 (Connected인데 빈 xoxb-…/xapp-… placeholder), a-16 (Linear는 'Connected — replace with a new Linear API key' placeholder); `SettingsPage.tsx` (p.slack 상태값이 이미 props로 존재)
- **상세**: Slack이 Connected인데 토큰 필드는 빈 입력으로 렌더링되어 토큰이 저장돼 있다는 시각적 단서가 없다. 같은 화면의 Linear 키는 placeholder로 저장 상태를 알려주는데, 같은 write-only 패턴에서 표현이 달라 Slack 쪽은 재입력해야 하나 불안하게 만든다.
- **제안**: Slack 토큰 필드도 저장 시 'Saved — enter a new token to replace' placeholder로 통일한다 (백엔드 변경 불필요).

#### #52 'N개 중 하나 선택' 세그먼트 컨트롤이 5가지 다른 시각 문법으로 구현됨
- **렌즈**: visual-consistency · **심각도**: medium · **공수**: M
- **증거**: `Sessions.tsx:40-79` (active bg-accent/15 + 슬라이딩 coral 밑줄), `RightSidebar.tsx:84-104` (bg-raised + 슬라이딩 밑줄), `GitChanges.tsx:150-156` (bg-raised만, 공용 훅 미사용), `SettingsPage.tsx:86-102` (border-b-2, 훅 미사용), `WorkerSpawnModal.tsx:102-125` (테두리 컨테이너 안 슬라이딩 pill); 스크린샷 a-05, a-21, a-12
- **상세**: 같은 인터랙션 패턴이 화면마다 다른 시각 언어를 써서 'coral 밑줄=선택'인지 'raised 배경=선택'인지 규칙이 성립하지 않는다. 공용 useSegmentIndicator 훅이 있음에도 3곳만 쓰고 스타일이 제각각이며, 특히 (2)와 (3)은 같은 Git 패널 흐름에서 연달아 보인다.
- **제안**: 밑줄형(내비게이션 계층)과 pill형(폼 내 선택) 2종으로 정리한 공용 Segment 컴포넌트를 만들어 5곳을 수렴한다.

#### #72 첫 실행 모달(DataConsent·Onboarding)이 앱의 버튼/모달 시스템을 따르지 않음
- **렌즈**: visual-consistency · **심각도**: low · **공수**: S
- **증거**: `DataConsentModal.tsx:17-22`, `OnboardingModal.tsx:13-14,40-47` (raw button: bg-accent+text-white+hover:bg-accent/90+rounded-lg, overlay bg-black/60) vs `ui/button.tsx:11` (primary: text-accent-ink+hover:bg-accent-hi+rounded-[var(--radius)]), `RepoModal.tsx` (bg-black/55 backdrop-blur-sm + dialog-in/out); 스크린샷 b-01, b-02 vs b-06
- **상세**: 사용자가 가장 먼저 보는 두 화면만 raw <button>으로 흰 글자·다른 라운딩을 쓰고, overlay도 blur·모션 없이 배경 처리가 다르다. 첫인상 구간에서 브랜드 시스템이 깨져 보인다. (a11y 계약 누락은 #25/#26.)
- **제안**: 버튼을 `<Button variant="primary">`로 교체하고 overlay/panel에 다른 모달과 동일한 클래스를 적용한다.

#### #73 파괴적 confirm 다이얼로그 4곳이 각자 손으로 만든 버튼 세트
- **렌즈**: visual-consistency · **심각도**: low · **공수**: S
- **증거**: `Sessions.tsx:349-350`, `RepoTree.tsx:227-228`, `GitChanges.tsx:248-249` (py-1/text-12/p-4/제목 13px로 혼자 다름), `FileTree.tsx:238-239` (한 푸터에 raw Cancel + 공용 Button confirm 혼합), `:259-260` vs `ui/button.tsx:11-21`
- **상세**: 세션 삭제/워커 삭제/git revert/파일 휴지통의 confirm이 전부 raw 버튼인데 서로 치수·패딩·제목 크기가 다르다. 특히 FileTree NameDialog는 한 푸터 안에서 두 버튼의 높이·라운딩(rounded-lg 8px vs --radius 10px)이 눈에 띄게 어긋난다.
- **제안**: Button에 danger-solid(bg-fail) variant를 추가해 4곳을 Button(outline+danger-solid)으로 통일하고, 공통 ConfirmDialog 컴포넌트로 추출해 패널 패딩/제목 크기도 고정한다.

#### #74 AutomationForm의 raw <select> 6곳이 공용 Select를 우회 — coral focus ring 없음
- **렌즈**: visual-consistency · **심각도**: low · **공수**: S
- **증거**: `AutomationForm.tsx:186,244,260,276,319,355,369` (raw select) vs `ui/input.tsx:5-9` (드리프트 방지 목적을 주석으로 명시한 공용 field cva); 스크린샷 a-11
- **상세**: 공용 Select는 정확히 이런 드리프트를 막으려 만들어졌는데 AutomationForm만 우회한다. focus 시 coral ring이 없고(px-2.5 vs md px-3 들여쓰기 차이, disabled 미정의), 같은 폼 안의 Input은 공용이라 한 폼에서 포커스 스타일이 섞인다.
- **제안**: raw select를 `<Select size="md" className="w-full">`로 교체한다 (옵션 마크업 유지 가능).

#### #75 AutomationForm 헤더만 오버레이 헤더 패턴을 벗어나고 '←' 텍스트 글리프를 아이콘 대신 사용
- **렌즈**: visual-consistency · **심각도**: low · **공수**: S
- **증거**: `AutomationForm.tsx:137-155` (px-4 py-3, eyebrow 없음, drag 없음, 닫기=리터럴 "←") vs `SettingsPage.tsx:64-70`, `AutomationPage.tsx:60-66`, `NewSessionPage.tsx:55-62` (drag h-11 px-5 + eyebrow + lucide X); 스크린샷 a-11 vs a-12, a-10
- **상세**: 오버레이 헤더 패턴(drag h-11 px-5 + mono eyebrow + 우측 lucide X)에서 AutomationForm만 이탈하고, 닫기 버튼이 앱의 다른 모든 아이콘과 달리 리터럴 문자 '←'다. 액션 배치도 Settings(본문 하단 Save)와 달리 헤더 우측 Cancel/Save로 어긋난다.
- **제안**: 헤더를 h-11 px-5 + eyebrow('Automation') 패턴으로 맞추고 '←'를 lucide ArrowLeft/X로 교체, 저장 버튼 위치는 Settings와 한쪽으로 통일한다.

#### #76 좌측 사이드바의 Sessions ↔ Repos 탭 간 리스트 행 스케일이 다름
- **렌즈**: visual-consistency · **심각도**: low · **공수**: S
- **증거**: `Sessions.tsx:213` (행 text-[13px] py-2 rounded-lg), `:202` (rename 13px py-1.5) vs `RepoTree.tsx:82` (12px py-1.5 rounded-md), `:71` (rename 12px py-1), `:118` (그룹 헤더 12.5px); 스크린샷 a-05 vs a-01
- **상세**: 같은 사이드바 자리에서 탭만 전환되는 두 리스트인데 밀도·라운딩·글자 크기가 전부 달라, 탭을 오갈 때 리스트 전체가 미묘하게 커졌다 작아졌다 하는 인상을 준다. 워커 트리가 한 단계 작게 갈 수는 있으나 라운딩·패딩까지 다를 이유는 없다.
- **제안**: 사이드바 리스트 행 토큰(글자 12.5px·py·rounded-md 등)을 하나 정해 두 뷰가 공유하고 rename input도 동일 치수로 맞춘다.

#### #77 섹션 eyebrow 마이크로라벨이 8.5/9.5/10/10.5/11/12px + tracking 4종으로 난립
- **렌즈**: visual-consistency · **심각도**: low · **공수**: S
- **증거**: `Sessions.tsx:268,296,362` (10.5px/0.12em) vs `RepoTree.tsx:165` (11px/0.1em — 같은 사이드바의 형제 컨텍스트); `GitChanges.tsx:126`; `CommitView.tsx:53`; `NestedAgents.tsx:17` (10px); `ResourceMonitor.tsx:30` (8.5px); `AutomationForm.tsx:163,181` (12px); `ToolBlock.tsx:86,92` (9.5px)
- **상세**: 같은 '섹션 구분 대문자 라벨' 역할인데 6가지 크기 × 4가지 자간 조합이라 화면 간 리듬이 미세하게 계속 어긋나고, 새 코드가 어느 값을 따라야 할지 기준이 없다.
- **제안**: eyebrow 유틸리티(.eyebrow-sm = 10.5px/0.12em 등)를 globals.css나 공용 컴포넌트로 승격하고 변형들을 한두 단계로 수렴한다.

#### #78 Git 패널의 Commit 버튼이 공용 primary와 다른 coral
- **렌즈**: visual-consistency · **심각도**: low · **공수**: S
- **증거**: `GitChanges.tsx:198-206` (raw: bg-accent/90→hover:bg-accent, rounded-md 6px, text-[12px] py-1.5) vs `ui/button.tsx:11` (primary: bg-accent→hover:bg-accent-hi, 10px, 13px, h-9 + inset 하이라이트); 스크린샷 a-21
- **상세**: 휴지 상태 색과 hover 색이 모두 공용 primary와 한 단계씩 어긋나 primary 액션 색이 두 벌 존재하게 된다. 기능상 문제는 없는 순수 시각 드리프트.
- **제안**: `<Button variant="primary" size="sm" className="w-full" loading={busy}>`로 교체한다 (disabled 스타일도 공용 정의를 따르게 됨).

#### #79 AutomationForm의 bypassPermissions 경고만 theme 토큰이 아닌 raw tailwind 노랑 사용
- **렌즈**: visual-consistency · **심각도**: low · **공수**: S
- **증거**: `AutomationForm.tsx:288,400` (text-yellow-500/80) vs `NewSessionPage.tsx:67-68` (text-run), `SettingsPage.tsx:323` (border-run/40 bg-run/12), `App.tsx:894`; 스크린샷 a-11
- **상세**: 앱의 경고 톤은 theme 토큰 --color-run(#f5b544)으로 통일돼 있는데 bypass 경고 한 곳만 Tailwind 팔레트 yellow-500을 써서 주변 run 톤 경고들과 미묘하게 다른 노랑으로 렌더링된다. 토큰 밖 색상은 팔레트 변경 시에도 누락된다.
- **제안**: text-yellow-500/80 → text-run/90 (또는 Settings와 동일한 run 박스 스타일로 승격).

#### #80 Revert 체크포인트 목록이 시각만 표시해 순서가 뒤집혀 보임
- **렌즈**: pixel-pass · **심각도**: low · **공수**: S
- **증거**: 스크린샷 a-18 (Turn 1 = 06:07 PM → Turn 2 = 12:32 PM); `CheckpointMenu.tsx`의 hhmm() (시각만 포맷)
- **상세**: 체크포인트가 날짜 없이 hh:mm만 표시돼, 자정을 넘긴 세션에서는 Turn 1(전날 저녁)이 Turn 2(다음날 오후)보다 늦은 시각으로 보인다. Turn 라벨에 내용 힌트도 없어 시각이 유일한 단서인데 그 단서가 모호하다.
- **제안**: 다른 날짜로 넘어가면 '어제 06:07 PM'/'7/2 18:07'처럼 날짜를 병기하거나 relativeTime을 사용한다.

#### #81 Slack 설정 상태 카드: 'Connected' 옆의 coral 'Off' 필이 상태인지 액션인지 모호
- **렌즈**: pixel-pass · **심각도**: low · **공수**: S
- **증거**: 스크린샷 a-14 (상단 상태 카드); `SettingsPage.tsx:185-192`; `i18n/en/settings.ts:41-47` (slackUp 'Connected' / toggleOff 'Off')
- **상세**: 상태 행이 좌측에 초록 dot + 'Connected', 우측에 coral 배경 'Off' 필을 동시에 보여준다. 'Off'가 토글 액션(끄기)임을 알기 전까지는 '연결됨인데 Off'라는 모순된 상태로 읽힌다.
- **제안**: 명시적 스위치 컴포넌트(On/Off 토글 + 상태 라벨 분리)로 교체하거나 버튼 라벨을 'Turn off'로 바꾼다.

---

## 부록: 기각된 발견

검증 단계에서 반박되어 인벤토리에서 제외한 8건. 투명성을 위해 기각 사유를 남긴다.

1. **coral 밑줄이 모든 dock 그룹의 active 탭에 동시에 그려짐** (visual-consistency) — 스크린샷 실측 반박: coral 밑줄은 포커스를 가진 단 하나의 그룹에만 렌더되며, base dockview.css의 .dv-active-group/.dv-inactive-group 캐스케이드를 확인하지 않은 CSS 소스만의 오판.
2. **팝업 메뉴 아이템 타이포/hover 톤이 메뉴마다 미세하게 다름** (visual-consistency) — 핵심 근거인 '행 높이 차이'가 사실이 아니고(모두 py-1.5 동일), 남은 0.5px/알파 10% 차이는 육안 식별 불가 + 나란히 비교될 일 없음.
3. **RepoModal만 소문자 버튼·placeholder-only 입력 사용** (visual-consistency) — 비교 근거 오류: WorkerSpawnModal도 소문자 'spawn', SettingsPage도 placeholder-only 입력 다수라 RepoModal만의 예외가 아님(표기 자체는 #64로 흡수).
4. **Git History/Commit/Diff 패널이 fetch 실패 시 무한 로딩** (state-coverage) — main의 exec 래퍼가 에러를 reject하지 않고 {code:1}로 resolve해 빈 상태로 정상 렌더됨; reject 가능 지점(guardCwd)은 실사용 흐름에서 도달하지 않는 이론적 엣지케이스.
5. **워커 스폰 진입점이 hover 전용 — 캡처 운영자도 못 찾음** (interaction-feedback) — 이 렌즈에서는 '의도된 1차 경로가 대화형(마스터에게 요청)'이라는 이유로 기각; 단, 동일 주제의 키보드 도달 불가·발견성 문제는 다른 3개 렌즈에서 확정되어 **#3**으로 수록됨.
6. **숨은 단축키에 대한 UI 힌트 전무** (a11y-keyboard) — composer placeholder에 'Shift+Enter 줄바꿈', 커밋 '(⌘↵)', 스폰 모달 '(⌘/Ctrl+Enter to spawn)' 힌트가 이미 존재해 핵심 근거가 반증됨.
7. **orphaned 워커 composer가 살아있는 입력창처럼 렌더링됨** (pixel-pass) — 실제로는 opacity-50/opacity-40+pointer-events-none으로 완전히 disabled 처리되어 있고 모델 라벨도 텍스트로 렌더되는 앱 전역 일관 패턴이라 반박됨(disabled 시각 강도 문제는 #39로 별도 수록).
8. **커밋 placeholder 'Commit staged changes…'인데 스테이징 개념이 UI에 없음** (pixel-pass) — GitChanges에 Staged/Changed 섹션과 행/섹션 단위 stage·unstage 버튼이 완전 구현되어 있음; 인용 스크린샷은 staged 0개의 빈 상태였을 뿐.

---

*집계 검증: 렌즈별 확정 102건 − 병합 21건 = 최종 81건 (high 3 · medium 49 · low 29). 병합 그룹: orphaned locating(4→1), file/diff 동일 라벨(4→1), 워커 스폰 진입점(3→1), 우클릭 전용 액션(3→1), dock 터미널(3→1), eyebrow 클래스/언어(3→1), 워커 상태 태그(3→1), hover 닫기 버튼(2→1), Tooltip CJK(2→1), worker/agent 용어(2→1), 네스티드 패널 명칭(2→1), en 케이싱(2→1).*
