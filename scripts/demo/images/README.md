# Isolated image UI fixture

This synthetic WS server uses the real bounded ImageStore, accepts image-only/mixed Master, Worker and Side inputs, replays references, and never runs a provider. It is separate from the live daemon and uses a temporary home. The Electron launcher refuses to start without the explicit fixture metadata and disables real-daemon fallback.

Use Node 22 and build both projects first:

```sh
npm run build
npm -w apps/desktop run build
ROOKERY_IMAGE_FIXTURE_DIR=/tmp/rookery-image-ui-check node scripts/demo/images/server.mjs
# In a second terminal, use the same directory:
ROOKERY_IMAGE_FIXTURE_DIR=/tmp/rookery-image-ui-check node_modules/.bin/electron scripts/demo/images/launcher.cjs
```

Select either synthetic session or the `Image follow-ups` Worker. Import a synthetic PNG via the picker, drop it, or paste it alongside text. Inspect previews/removal, send mixed/image-only messages, reopen the session, and reload Electron to verify reference history/drafts. Open Side with the separate-question action and send an image-only follow-up. File selection still uses the real native dialog. Only fixture state is written under the chosen temporary directory.

Use the existing CDP client (`scripts/demo/cdp.mjs`, port 19239 by default) to capture 1440×1000 and 920×700 windows, and inspect both the default dock layout and the static layout fallback. To test rejection, drop SVG, a >3 MiB file or >4 images; the input must remain retryable. Deleting only a fixture asset under `home/images/<id>` exercises the missing-history placeholder/retry. No screenshot or fixture should contain user data.

Automated integration equivalents: `test/daemon/desktop-image-acceptance.test.ts`, `apps/desktop/test/composer-images.test.tsx`, `message-images.test.tsx`, and `store-pending.test.ts`.
