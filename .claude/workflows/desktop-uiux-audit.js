export const meta = {
  name: 'desktop-uiux-audit',
  description: 'Lens-based parallel UI/UX audit of the rookery desktop renderer (screenshots + code)',
  whenToUse: 'After capturing a screenshot set of the desktop app (Phase 0, done inline), to produce a prioritized UI/UX issue inventory. Pass args {shotsDir, notes?, outPath?}.',
  phases: [
    { title: 'Lens audit', detail: '7 parallel lens agents over screenshots + renderer code' },
    { title: 'Verify', detail: 'per-finding adversarial verify + severity/effort scoring' },
    { title: 'Synthesize', detail: 'merge duplicates, group by theme, write prioritized report' },
    { title: 'Critique', detail: 'completeness critic checks and fixes the report' },
  ],
}

if (!args || typeof args.shotsDir !== 'string' || !args.shotsDir) {
  throw new Error('args.shotsDir is required — run the Phase 0 capture first and pass the screenshot directory (absolute path)')
}
const SHOTS = args.shotsDir
const NOTES = (args && args.notes) || '(none)'
const OUT = (args && args.outPath) || 'docs/2026-07-03-desktop-uiux-audit.md'
const REPO = '/Users/clover/workspace/clovot'

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'detail', 'evidence', 'components'],
        properties: {
          id: { type: 'string', description: 'short kebab-case slug, unique within this lens' },
          title: { type: 'string', description: 'one-line finding title, Korean' },
          detail: { type: 'string', description: 'what is wrong and why it hurts the user, Korean' },
          evidence: { type: 'string', description: 'file:line refs and/or screenshot filenames that show it' },
          components: { type: 'array', items: { type: 'string' }, description: 'affected component/file names' },
          suggestion: { type: 'string', description: 'optional concrete fix sketch, Korean' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['real', 'severity', 'effort', 'reason'],
  properties: {
    real: { type: 'boolean' },
    severity: { type: 'string', enum: ['high', 'medium', 'low'] },
    effort: { type: 'string', enum: ['S', 'M', 'L'] },
    reason: { type: 'string', description: 'one-line verdict rationale, Korean' },
  },
}

const SYNTH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reportPath', 'summary', 'merged'],
  properties: {
    reportPath: { type: 'string' },
    summary: { type: 'string', description: '5-10 line Korean executive summary of the audit' },
    merged: { type: 'number', description: 'how many findings were merged away as duplicates' },
  },
}

const CRITIC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'fixes'],
  properties: {
    ok: { type: 'boolean', description: 'true if the report needed no or only minor fixes' },
    fixes: { type: 'array', items: { type: 'string' }, description: 'what was fixed or flagged, Korean' },
  },
}

const LENSES = [
  {
    key: 'visual-consistency',
    focus: 'Visual consistency: spacing/typography/color/density drift. Look for inconsistent paddings and gaps between sibling components, ad-hoc Tailwind values where a shared pattern exists, mixed border/rounding/shadow treatments, inconsistent font sizes/weights for the same semantic role, misaligned rows/icons, and drift between the dock theme and the rest of the app.',
    hints: 'apps/desktop/src/renderer/globals.css, apps/desktop/src/renderer/ui/, apps/desktop/src/renderer/workspace/dockview-theme.css, className patterns across apps/desktop/src/renderer/components/',
  },
  {
    key: 'state-coverage',
    focus: 'State coverage: loading/empty/error/skeleton states. For every data-driven surface, check what renders while loading, when the list is empty, and when the fetch or WS request fails. Look for layout jumps when data arrives, missing empty-state guidance (blank panels with no hint), spinners that never resolve, and errors that vanish silently instead of surfacing.',
    hints: 'apps/desktop/src/renderer/components/Skeleton.tsx usage, views/Sessions.tsx, views/RepoTree.tsx, components/GitChanges.tsx, components/GitHistory.tsx, components/UsagePanel.tsx, components/AutomationPage.tsx, store/ fetch paths',
  },
  {
    key: 'interaction-feedback',
    focus: 'Interaction feedback: does every action visibly respond? Check hover/active/focus/disabled treatments on clickable things, feedback for in-flight actions (send, spawn, stop, discard, save), optimistic updates and their failure rollback UX, toast usage consistency, destructive-action confirmation consistency, and dead zones where a click does nothing without explanation.',
    hints: 'apps/desktop/src/renderer/components/Composer.tsx, Toaster.tsx, WorkerSpawnModal.tsx, CheckpointMenu.tsx, ContextMenu.tsx, SettingsPage.tsx save flows, pendingBySession/pendingByWorker rendering in MessageList.tsx',
  },
  {
    key: 'ia-navigation',
    focus: 'Information architecture and navigation: the dock/tab/sidebar model. Check discoverability of features (can a new user find the terminal, diff view, worker transcript, fork, checkpoints?), tab overflow behavior, whether current location is always clear, consistency between left sessions list / right sidebar segments / dock panels, and whether frequent flows (open session -> inspect worker -> view diff) take too many steps.',
    hints: 'apps/desktop/src/renderer/workspace/ (WorkspaceDock.tsx, panels.tsx, default-template.ts), components/TabBar.tsx, RightSidebar.tsx, views/Sessions.tsx, lib/view-state.ts, apps/desktop/AGENTS.md workspace section',
  },
  {
    key: 'copy-i18n',
    focus: 'Copy and i18n quality: awkward or inconsistent wording in BOTH locales, terms translated inconsistently across namespaces (same concept, different words), text truncation/overflow visible in screenshots, placeholder/tooltip/aria texts that are missing or unhelpful, and tone drift (formal vs casual) within one locale. The ko/en key-parity is already test-enforced — do not report parity, report quality.',
    hints: 'apps/desktop/src/renderer/i18n/locales/ko/ and en/ (all namespaces), ko/en screenshot pairs in the shots directory',
  },
  {
    key: 'a11y-keyboard',
    focus: 'Accessibility and keyboard: focus management in modals (trap, restore on close, Escape), Tab order through composer/sidebar/dock, missing aria-labels on icon-only buttons, keyboard operability of context menus and menus, visible focus rings, and useful shortcuts that are missing or undiscoverable (no hint anywhere).',
    hints: 'apps/desktop/src/renderer/components/ modals (WorkerSpawnModal.tsx, RepoModal.tsx, OnboardingModal.tsx, DataConsentModal.tsx), ContextMenu.tsx, Tooltip.tsx, icon-only buttons across components/, Composer.tsx key handling',
  },
  {
    key: 'pixel-pass',
    focus: 'Pure pixel pass: judge ONLY what the screenshots show, as a demanding design reviewer seeing the app for the first time. Look for anything that looks broken, cramped, misaligned, clipped, low-contrast, visually noisy, or amateurish; awkward proportions; walls of same-weight text; unclear visual hierarchy (what should I look at first?). Cite the screenshot filename for every finding. Only open code if you need to confirm something is not a capture artifact.',
    hints: 'the screenshots directory only',
  },
]

function lensPrompt(lens) {
  return [
    `You are one lens of a UI/UX audit of "rookery" — an Electron mission-control GUI (React 18 + Tailwind v4 + Zustand) for an agent-orchestrator daemon. Repo root: ${REPO}. Renderer code: apps/desktop/src/renderer/.`,
    `Screenshots of the running app are in: ${SHOTS} — read ${SHOTS}/manifest.md first (it describes each shot); if it is missing, list the directory. View the shots relevant to your lens with the Read tool. Capture notes from the operator: ${NOTES}`,
    `Read apps/desktop/AGENTS.md first for architecture context so you do not report intentional design as a bug (e.g., Slack-origin sessions are read-only on purpose; the nested-agents panel is live-only on purpose).`,
    `YOUR LENS — ${lens.key}: ${lens.focus}`,
    `Likely-relevant places to start (not exhaustive): ${lens.hints}`,
    `Rules for findings:`,
    `- Concrete and actionable only. No grand redesign proposals, no new product features — missing affordances/states/feedback within existing features are in scope.`,
    `- Every finding needs evidence: file:line refs and/or a screenshot filename. If you cannot point at evidence, drop it.`,
    `- Report UX quality issues, not code-quality issues (a separate audit already covered correctness).`,
    `- Titles/details/suggestions in Korean; keep technical terms, component names, and file paths in English.`,
    `- Be thorough: sweep every surface your lens applies to, not just the hinted files. Aim for completeness over restraint — a later adversarial pass will filter.`,
    `Return your findings via the structured output schema.`,
  ].join('\n\n')
}

function verifyPrompt(f) {
  return [
    `Adversarially verify one finding from a UI/UX audit of the rookery desktop app (repo root ${REPO}, renderer apps/desktop/src/renderer/, screenshots in ${SHOTS}).`,
    `Try to REFUTE it. Check the cited evidence yourself (open the files, view the screenshots). It is NOT real if: the evidence does not hold; it is intentional design per apps/desktop/AGENTS.md or docs/; it is already handled somewhere the finder missed; or it is so subjective that no reasonable user would be bothered. When genuinely uncertain, lean real=false.`,
    `If it survives, score it: severity high = blocks or confuses a core flow, or looks broken; medium = noticeable friction or inconsistency; low = polish. Effort S = under ~1h, single-file tweak; M = multi-file or needs a design decision; L = structural.`,
    `Finding (JSON): ${JSON.stringify(f)}`,
  ].join('\n\n')
}

function synthPrompt(confirmed, rejected) {
  return [
    `You are the synthesizer of a UI/UX audit of the rookery desktop app. Write the final report to ${OUT} (Write tool; repo root ${REPO}), then return the structured output.`,
    `Merge duplicates: findings from different lenses describing the same underlying issue become ONE entry (union the evidence, keep the better suggestion). Group entries by theme (not by lens). Order by severity high→low, then effort S→L.`,
    `Report language: Korean prose with English technical terms and file paths. Structure:`,
    `## 요약 — counts by severity, plus a "quick wins" list (severity high/medium AND effort S).`,
    `## 우선순위 인벤토리 — table: #, title, severity, effort, components.`,
    `## 테마별 상세 — each entry: title, lens(es), evidence, detail, suggestion.`,
    `## 부록: 기각된 발견 — title + one-line rejection reason each (for transparency).`,
    `Every confirmed finding must appear exactly once (a merged entry counts for all its members). Do not invent findings that are not in the input.`,
    `Confirmed findings JSON:\n${JSON.stringify(confirmed, null, 1)}`,
    `Rejected findings JSON:\n${JSON.stringify(rejected, null, 1)}`,
  ].join('\n\n')
}

function criticPrompt(confirmed) {
  return [
    `You are the completeness critic for a UI/UX audit report at ${OUT} (repo root ${REPO}).`,
    `Check: (1) every confirmed finding below appears in the report exactly once (merged entries count for their members); (2) every entry cites its evidence; (3) the priority table matches the detail sections; (4) severity/effort values are consistent between table and details; (5) the quick-wins list actually contains only high/medium + S items.`,
    `Fix any gaps DIRECTLY in the report file with Edit, then return the structured output listing what you fixed. If nothing needed fixing, return ok=true with an empty fixes list.`,
    `Confirmed findings JSON:\n${JSON.stringify(confirmed, null, 1)}`,
  ].join('\n\n')
}

// --- Phase 1+2: lens fan-out, each lens's findings verified as soon as that lens finishes ---
const perLens = await pipeline(
  LENSES,
  (l) => agent(lensPrompt(l), { label: `lens:${l.key}`, phase: 'Lens audit', schema: FINDINGS_SCHEMA }),
  (res, l) => {
    if (!res) return []
    log(`lens:${l.key} → ${res.findings.length} findings`)
    return parallel(res.findings.map((f) => () =>
      agent(verifyPrompt(f), { label: `verify:${l.key}/${f.id}`, phase: 'Verify', schema: VERDICT_SCHEMA })
        .then((v) => ({ ...f, lens: l.key, verdict: v }))
    ))
  },
)

const verified = perLens.filter(Boolean).flat().filter(Boolean).filter((f) => f.verdict)
const confirmed = verified.filter((f) => f.verdict.real)
const rejected = verified
  .filter((f) => !f.verdict.real)
  .map((f) => ({ title: f.title, lens: f.lens, reason: f.verdict.reason }))
log(`confirmed ${confirmed.length} / rejected ${rejected.length} findings`)

if (confirmed.length === 0) {
  return { reportPath: null, confirmed: 0, rejected: rejected.length, summary: 'No findings survived verification — nothing to report.', rejectedFindings: rejected }
}

// --- Phase 3: synthesis (barrier is inherent — needs every verdict) ---
const synth = await agent(synthPrompt(confirmed, rejected), { label: 'synthesize', phase: 'Synthesize', schema: SYNTH_SCHEMA })

// --- Phase 4: completeness critic ---
const critique = await agent(criticPrompt(confirmed), { label: 'critic', phase: 'Critique', schema: CRITIC_SCHEMA })

return {
  reportPath: (synth && synth.reportPath) || OUT,
  confirmed: confirmed.length,
  rejected: rejected.length,
  mergedDuplicates: synth ? synth.merged : null,
  summary: synth ? synth.summary : null,
  critic: critique,
}
