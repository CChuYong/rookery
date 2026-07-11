// Seeds an ISOLATED demo home so the app looks lived-in on camera: settings done, the sample
// repo registered, a (disabled) worker-settled reviewer automation, and a little REAL session/
// worker history (real runs on a cheap model — nothing is forged, so everything renders exactly
// like production data).
//
// Prereqs: a daemon already running on the target home (e.g.
//   ROOKERY_HOME=/tmp/rookery-demo node dist/index.js daemon
// ) and Anthropic auth available (env key or `claude login`). Real turns cost real (cent-level) money.
//
// Usage: node scripts/demo/seed.mjs --home /tmp/rookery-demo --repo /tmp/orbitkit [--port 8787] [--with-worker]
import { connectDaemon, waitHealthy } from "./daemon-ws.mjs";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const has = (name) => process.argv.includes(`--${name}`);

const home = arg("home");
const repo = arg("repo");
const port = Number(arg("port", "8787"));
const FILLER_MODEL = arg("filler-model", "claude-haiku-4-5-20251001"); // cheap; effort is auto-omitted for haiku
if (!home || !repo) {
  console.error("usage: node scripts/demo/seed.mjs --home <rookery-home> --repo <sample-repo> [--port 8787] [--with-worker]");
  process.exit(1);
}

await waitHealthy({ port });
const d = await connectDaemon({ home, port });
d.send({ type: "events.subscribe" });
const log = (m) => console.log(`[seed] ${m}`);

// 1) First-run gates done + defaults, so the recording starts on a configured app.
await d.request({ type: "settings.set", settings: { hasAcceptedDataNotice: "1", onboardingDone: "1", defaultSessionCwd: repo } });
log("settings: consent/onboarding done, default cwd set");

// 2) Register the sample repo.
await d.request({ type: "repos.register", name: "orbitkit", path: repo, description: "Static changelog & release-feed generator", base: "main" });
log("repo registered: orbitkit");

// 3) The reviewer automation (scene 4 star). Seeded DISABLED so seeding itself can't trigger it;
//    the conductor enables it right before the scene via automation.set_enabled.
const auto = await d.request({
  type: "automation.create",
  automation: {
    name: "Review finished workers",
    enabled: false,
    trigger: { kind: "worker", repo: "orbitkit", on: ["stopped", "idle"] },
    action: {
      kind: "worker",
      repo: "orbitkit",
      task: "An implementation worker just settled on branch {{branch}} (status: {{status}}). Its last report:\n{{tail}}\n\nCheck out the diff (git diff main...{{branch}}), review it for correctness and missing tests, and report a verdict with any issues found.",
    },
    maxTurns: 40,
    costBudgetUsd: 2,
  },
});
log(`automation created (disabled): ${auto.automation?.id ?? "ok"}`);

// 4) Real session history on a cheap model — the sidebar shouldn't be empty on camera.
async function fillerTurn(label, prompt) {
  const created = await d.request({ type: "session.create", cwd: repo });
  const sid = created.sessionId;
  await d.request({ type: "session.rename", sessionId: sid, label });
  const done = d.waitForEvent(
    (e) => e.type === "master.result" && e.sessionId === sid,
    { timeoutMs: 300000, label: `master.result of "${label}"` },
  );
  await d.request({ type: "session.send", sessionId: sid, text: prompt, model: FILLER_MODEL });
  await done;
  log(`filler session done: ${label}`);
  return sid;
}

await fillerTurn("Repo tour", "Give me a 3-bullet summary of the orbitkit repo's current state. Keep it short.");
await fillerTurn(
  "Release cadence",
  "Remember this: orbitkit release notes go out every other Tuesday. Then confirm in one line.",
);

// 5) Optional: one settled worker so the fleet view has history too.
if (has("with-worker")) {
  const spawned = await d.request({
    type: "fleet.spawn",
    repo: "orbitkit",
    task: "Add one happy-path unit test for renderChangelog in test/. Run node --test to confirm, commit on your branch. Do NOT fix any bugs you notice — test only.",
    label: "changelog test",
    model: FILLER_MODEL,
    costBudgetUsd: 1,
  });
  const wid = spawned.id;
  log(`filler worker spawned: ${wid} — waiting for settle`);
  await d.waitForEvent(
    (e) => e.type === "worker.status" && e.workerId === wid && ["idle", "stopped", "error", "failed"].includes(e.status),
    { timeoutMs: 900000, label: "filler worker settle" },
  );
  await d.request({ type: "fleet.stop", id: wid }).catch(() => {});
  log("filler worker settled + stopped");
}

log("done");
d.close();
