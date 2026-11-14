# Provider speed controls and direct image input

## Intent and authorization

Implement priority 1 (Fast Mode) and priority 3 (direct image input) from the SDK gap audit. The user explicitly requested a Superpowers spec, implementation plan, implementation, and visual inspection, autonomously while away. Intermediate design approvals are delegated to the controller. Start from origin/main at 40d9208 (merged UI polish PR #27). Keep commits and PR prose English.

This is an architectural change: provider configuration and multimodal inputs cross transport, core, persistence, and desktop boundaries. Use a managed isolated worktree, task implementers, independent task reviews, then full-branch review. Do not merge main or publish a release.

## Alternatives and decisions

1. Add UI-only controls and keep image paths in text: small, but does not deliver either requested native feature. Rejected.
2. Send and persist inline image base64 with every transcript event: simple, but history returns thousands of events and forks copy them; reconnect grows without bound. Rejected.
3. Use explicit speed preferences and bounded image assets, with typed runtime inputs and reference-only history. Selected.

Two UI speed choices are Standard and Fast. Unset target preferences inherit Rookery's provider/role setting (initially Standard), not the user's implicit provider speed. This makes selection predictable and prevents inherited Fast being priced as Standard. Ultrafast, voice, steering, and structured output are out of scope.

## Speed behavior

- Neutral `SpeedPreference = "standard" | "fast"`. Persist nullable target overrides for sessions/workers/automations; null inherits provider/role default. Four settings: `masterSpeed`, `workerSpeed`, `codexMasterSpeed`, `codexWorkerSpeed`, all default Standard. Resolve defaults at the next turn boundary, not target construction.
- Add speed to session creation/send, worker spawn/send or dedicated setSpeed, native forks, automation configuration/action and fleet MCP inputs. Preserve overrides across restart, reload and same-provider fork. Cross-provider forks preserve Standard/Fast intent but recompute capability/state. Side conversations inherit the source preference; no separate Side speed setting is required.
- Changing speed while busy applies to the next user turn. Do not interrupt running work. Snapshot the billed/requested speed at turn start. Expose pending vs applied selection without claiming changes affected an in-flight turn.
- Claude: initial options `settings: {fastMode: speed === "fast"}`; streaming control `applyFlagSettings({fastMode: ...})` must complete before next queued input is delivered. Do not modify real user config. Preserve SDK cost differencing without multiplication. Decode `fast_mode_state` and disabled reason on init/result into neutral observations.
- Codex: use `turn/start.serviceTierForTurn = "default" | "fast"`, avoiding sticky thread settings. Ground truth is CLI 0.169.0. Deliberately raise the supported CLI minimum to 0.169.0, update protocol/version documentation and version tests together, and retain the actionable upgrade error. This avoids guessing the introduction version of per-turn speed overrides.
- Preserve `model/list.serviceTiers` metadata. Disable Fast for models whose authoritative catalog explicitly excludes it; absence of metadata means unknown, not unsupported. Claude SDK `supportedModels().supportsFastMode` may supply runtime capability; do not hard-code temporary model availability. Cold unknown availability permits a request and explains that availability is checked on execution.
- `SpeedObservation` contains requested Standard/Fast, state `unknown | standard | fast | cooldown`, and optional provider reason. Codex accepted Fast is only a requested/configured speed, not proof of actual service. Never invent effective Fast from a successful request. Unknown future reason strings must render safely with a generic localized explanation.
- Emit/persist speed observations for master and worker transcripts and hydrate them on reconnect. UI shows selected preference beside model/effort and a concise state/detail when unknown, blocked or cooldown. Provider-reported state is not a per-request performance guarantee.

## Cost policy

- Claude continues to use reported SDK USD totals.
- Codex remains an explicit token-price estimate in this slice; label it as estimated, including budget wording. Do not introduce cumulative native-cost accounting that risks charging prior fork/resume history twice.
- Add separate Standard/Fast rate tables from official pricing, not a blanket multiplier. GPT-5.5 Fast is 2.5x Standard, unlike several 2x rows. Include documented long-context rates for supported models or explicitly mark the cost estimate unavailable when a request falls outside the covered rate table. Never silently use the short-context/Standard rate for a known uncovered case.
- Unknown model-tier pricing is unavailable, not a truthful $0. Propagate accounting quality (`reported | estimated | unavailable`) with results. Keep the existing numeric field for wire compatibility, but display unknown when unavailable and emit an actionable notice. A worker with a cost budget must not keep executing when cost accounting is unavailable; stop further turns at the boundary. A master warns as its existing budget policy does.
- Exact Fast input/cached/output USD per million: 6.1-sol 4/.20/20; 6.1-terra 2/.10/10; 6-astra 20/2/100; 6-sol 4/.40/20; 6-luna .20/.02/1; 5.6-sol 8/.80/40; 5.6-terra 4/.40/24; 5.6-luna .40/.04/2.40; 5.5 12.50/1.25/75; 5.4 5/.50/30; 5.4-mini 1.50/.15/9. No inferred Fast row for 5.5-pro or 5.4-nano. Document source and verification date in pricing code.

## Image input and storage

- Desktop supports picker, drag/drop and clipboard images; preview thumbnails, filename, remove action and clear import errors. Preserve ordinary text paste and non-image `@path` attachments. Never upload image bytes merely because a path is mentioned in text.
- Support mixed text/images and image-only sends for new/existing Master, Worker follow-ups and Side conversations. Worker spawn modal tasks remain text-only; images can be sent after spawn. Keep one pending message for the whole text+image input.
- PNG/JPEG/WebP/GIF only; 4 images/message, 3 MiB decoded bytes/image, 8 MiB decoded bytes/message, max dimension 8000, max 20,000,000 pixels. These are product bounds, not claims about provider maxima. Reject SVG and remote URLs. Preserve bytes; do not silently resize or strip content.
- Store immutable assets under `<ROOKERY_HOME>/images/` (0700) with 0600 files, opaque random UUID ids, atomic creation, no symlink following. Add append-only SQLite metadata table: id, MIME, byte length, dimensions, sanitized original name, creation timestamp. Authenticate upload/get through the existing WebSocket. Validate canonical base64, MIME/signature agreement, actual byte length and parsed dimensions. A small audited image-header dependency is acceptable; no Electron runtime in daemon/core.
- `image.upload` receives name/mediaType/base64 and returns authoritative `ImageRef`; `image.get` accepts only opaque id and returns bounded data. Never accept client paths or fetch network URLs. Cap inbound WS frames at 16 MiB, assets at 1 GiB total; serialize quota reservation so concurrent uploads cannot bypass the cap. Fail clearly at quota. Do not delete image assets implicitly: forks and persisted drafts may still reference them. Record this retention policy in docs.
- `ImageRef = {id,name,mediaType,byteLength,width,height}`. Wire sends carry only ids/refs; validate against stored metadata before echo/provider execution. Missing/tampered ids fail with a retryable error and never silently omit the image.
- Core uses an injectable image resolution port; wiring belongs in daemon/server.ts. Provider input is `string | {text:string, images:ResolvedImage[]}` with `ResolvedImage = {mediaType,data}` (base64). Strings remain supported for CLI/Slack/tools/automation and existing tests.
- Claude image-bearing turns use a finite async iterable of one SDK user message containing text and base64 image blocks. Text-only master turns retain string input. Worker queue/deferred FIFO keeps each image list with its own message. Codex uses native image data-URL input items, not path prompts.
- Persist references in existing master/worker event JSON and pending state, not image bytes. Keep messages.content as textual index. Rendering loads images lazily by id with a bounded cache. Draft storage is versioned, backwards-compatible and reference-only. Pending/echo deduplication must distinguish consecutive image-only inputs. Failed sends and failed new-session creation retain text and images for retry; navigation must not leak attachments between targets.
- Same-provider forks reuse blob refs and native provider history. Cross-provider handoff remains the existing textual history summary; do not claim it replays old vision inputs. The newly submitted images are always sent natively. Show missing image history placeholders rather than breaking the conversation.

## Architecture and UI

Keep core transport-agnostic. Add focused modules for speed contracts, image contracts/store and desktop image previews/import helpers. Extend existing Composer controls rather than introducing a second settings system. Both duplicated App layout branches must use the same input plumbing. Existing desktop IDE styling and ko/en catalogs apply. No unrelated redesign.

Image picker must return bytes only for a user-selected file, not introduce an unrestricted filesystem-read IPC. Renderer File objects handle paste/drop; importing is bounded before base64 allocation. Pending imports cannot be sent prematurely, and async completions must not attach to a different draft after navigation/unmount.

## Verification and acceptance

1. Fresh Node 22 dependency install matches lockfile; baseline root/desktop typechecks and suites pass.
2. Tests cover provider speed request mapping, observation absence/cooldown/disabled reasons, per-turn changes and captured pricing tier; migrations/settings/serialization/fork/reload; GPT-5.5 Fast and unknown-price budget handling.
3. Tests cover image validation/quota/symlinks/restart reads, native Claude/Codex image input, image-only input, deferred FIFO and failed-send replay, compact reference-only history, forks and Side.
4. Desktop tests cover selection persistence, both layout branches, import sources, thumbnail removal, image-only start/send, mixed clipboard, draft migration, duplicate echo reconciliation and failed import/send.
5. Root and desktop typechecks, all tests and builds pass after integration. Run an isolated daemon/WS smoke with fake/injected providers for end-to-end serialization/persistence; use minimal live provider probes where account access permits and record any account restriction honestly.
6. Visually inspect actual rendered UI at wide and narrow sizes: speed selection/state, mixed/image-only composer, thumbnail removal, pending/committed/reloaded messages. Save screenshots in local test artifacts, not user-data screenshots in public PRs.
7. Independent task review plus whole-branch review; fix material findings. Deliver English commits and a reviewable feature branch; do not merge without instruction.

## Sources checked 2026-11-14

- https://code.claude.com/docs/en/agent-sdk/typescript
- https://code.claude.com/docs/en/fast-mode
- https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode
- https://platform.claude.com/docs/en/build-with-claude/vision
- https://learn.chatgpt.com/docs/app-server
- https://learn.chatgpt.com/docs/agent-configuration/speed
- https://developers.openai.com/api/docs/pricing.md
- Installed Claude SDK 0.3.325 and generated Codex CLI 0.169.0 schemas.
