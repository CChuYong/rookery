# Demo kit

Records the desktop app **hands-free**: CDP (Chrome DevTools Protocol) drives the renderer
(synthetic cursor, eased mouse, paced typing) and captures a screencast, ffmpeg assembles
mp4/GIF. Everything runs against an **isolated home** — real daemon, real (cheap-model) runs,
nothing forged, no contact with `~/.rookery`.

## Pieces

| file | what |
|---|---|
| `cdp.mjs` | minimal CDP client (Node 22 built-in WebSocket, zero deps) |
| `input.mjs` | synthetic cursor + moveMouse/click/clickText/typeText |
| `record.mjs` | `Page.startScreencast` → frames → `assembleMp4` / `toGif` (also a CLI smoke recorder) |
| `shot.mjs` | one-off PNG screenshot |
| `daemon-ws.mjs` | daemon protocol client (reads `ws-token`, reqId correlation, `waitForEvent`) |
| `make-sample-repo.mjs` | generates **orbitkit**, the fictional demo repo (planted bug: changelog month off-by-one; planted feature: `--json` flag) |
| `seed.mjs` | seeds the demo home: settings/repo/reviewer-automation + REAL filler sessions (+ `--with-worker`) |
| `smoke.mjs` | pipeline smoke: records consent → onboarding → Getting Started checklist |

## Recipe

```bash
npm run build                                        # root dist (daemon)
node scripts/demo/make-sample-repo.mjs /tmp/demo/orbitkit

# 1) daemon first, on an isolated home/port
ROOKERY_HOME=/tmp/demo/home ROOKERY_PORT=8899 node dist/index.js daemon &

# 2) seed BEFORE launching the app — settings/repos are pull-based, a live app won't see them
node scripts/demo/seed.mjs --home /tmp/demo/home --repo /tmp/demo/orbitkit --port 8899 --with-worker

# 3) app with CDP enabled (it discovers the running daemon via /health)
ROOKERY_HOME=/tmp/demo/home ROOKERY_PORT=8899 ROOKERY_DEBUG_PORT=9223 npm -w apps/desktop run dev

# 4) record (or drive scenes with your own script on top of input.mjs/record.mjs)
node scripts/demo/record.mjs --port 9223 --seconds 10 --out /tmp/demo/rec
```

Gotchas learned the hard way:

- **Seed before app**: `settings.set`/`repos.register` from another WS client don't push to an
  already-open renderer (sessions/fleet do, via events).
- Real filler turns need Anthropic auth (env key or `claude login`) and cost cent-level money.
- The screencast has no OS cursor — `installCursor()` injects one that tracks CDP mouse events.
- Locale on camera follows the OS (`system`); force it in Settings → Language before shooting.
