# 90-second demo — storyboard

Two deliverables cut from one (or two) recorded takes:

- **`hero.gif`** (15–20s, silent, autoplay) — README top: scenes 2+4 highlights only.
- **`demo-90s.mp4`** (YouTube/social) — all five scenes, caption cards between them.

Narrative spine: **"your fleet keeps working when you're not looking."**
English UI for the global cut; the whole thing is scripted, so a Korean re-take is a re-run.

| # | ~s | scene (what's on screen) | proves | how it's driven |
|---|----|--------------------------|--------|-----------------|
| 1 | 0–15 | An ask arrives in plain language: *"Fix the changelog date bug in orbitkit and add a test."* Master replies, calls `spawn_worker` — a tool card flips in_progress→complete, a worker appears. | natural-language orchestration | Slack (phone frame, optional v2) or the app composer: `typeText` + Enter |
| 2 | 15–35 | Fleet view: 2–3 workers in parallel (`fix changelog dates`, `--json flag`), each with its own `rookery/<id>` branch, live status + per-worker cost ticking. | safe parallelism, worktree isolation | conductor pre-spawned worker #2 via `fleet.spawn`; camera pans the repo tree |
| 3 | 35–50 | **Close the app window.** Beat. Reopen — sessions, transcripts (tools/thinking included), and both running workers are all still there. | resident daemon — the moat | kill/relaunch the app process; daemon untouched |
| 4 | 50–70 | Worker 1 settles → the **reviewer automation** fires on its own: a review worker spawns on the same branch, posts a verdict. | event-reactive fleet (rule, not ritual) | `automation.set_enabled` armed before the take; wait on `worker.status` |
| 5 | 70–90 | Attention bell: ranked queue (blocked question → failure → unreviewed result). Click through → diff view → tell the worker *"ship it"* → it runs `gh pr create`, PR URL lands in chat. | you only decide; honest signals | `clickSelector` bell → diff tab → `typeText` |

Caption cards (2s each, cut between scenes): `Your fleet, not your tabs` · `Every worker in its own
worktree` · `Close the app. Nothing stops.` · `Rules, not rituals` · `You review. It ships.`

## Shot settings

- Window 1440×900 (`BrowserWindow` default is fine; set via `Browser.setWindowBounds` if needed),
  screencast `maxWidth: 1440` → crisp 720p-ish GIF downscale.
- Hide the real usage panel numbers: the isolated home's own usage is near-zero from seeding, but
  the **account-wide** Claude gauge shows real spend — keep the sidebar collapsed in tight shots,
  or crop; don't leak.
- Cursor: `installCursor()` immediately after attach; it survives view switches (single React root).
- Waiting is edited, not endured: record the whole take, then cut LLM latency in ffmpeg
  (`-ss/-to` segment list → concat). Speed up long tool stretches 4–8× with `setpts`.

## Edit (ffmpeg)

```bash
# cut list → concat → captions
ffmpeg -i take.mp4 -ss 00:00 -to 00:14 -c copy s1.mp4   # ...per scene
ffmpeg -f concat -safe 0 -i cuts.txt -c copy rough.mp4
# caption cards: 1440x900 PNGs (generate with any tool), 2s each, concat between scenes
# final polish: light zoom on key moments via zoompan if wanted
node -e 'import("./scripts/demo/record.mjs").then(m => m.toGif("final.mp4","hero.gif",{fps:12,width:920}))'
```

## Open items before the full take

1. **Scene 1 surface**: app composer (v1, zero external deps) vs real Slack (v2 — needs a
   workspace/channel the team is OK showing on camera + phone-frame capture of Slack web).
2. **On-camera worker model**: filler seeding uses haiku, but the on-camera fix should look sharp —
   sonnet or opus, a few dollars per full take.
3. `costBudgetUsd` on every on-camera spawn (2–3 USD) so a retake can't run away.
