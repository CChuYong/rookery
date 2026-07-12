// Take 1 — scenes 1+2 of STORYBOARD.md: natural-language ask in the composer → master spawns
// worker 1; conductor spawns worker 2 over WS; camera moves to the fleet view (parallel workers).
// Leaves both workers RUNNING (takes 2/3 pick them up). Requires: seeded home, app up with CDP.
//
// Usage: node scripts/demo/shoot-s12.mjs --home <demo-home> --port 8899 --cdp 9223 --out <dir>
import path from "node:path";
import { connectPage, sleep } from "./cdp.mjs";
import { installCursor, clickText, clickSelector, typeText, pressEnter, moveMouse } from "./input.mjs";
import { startRecording, assembleMp4 } from "./record.mjs";
import { connectDaemon } from "./daemon-ws.mjs";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const out = arg("out", "/tmp/demo-take1");
const ASK = "The changelog shows the wrong month for every release. Find the bug in orbitkit, fix it with a regression test, and commit on a branch.";

const d = await connectDaemon({ home: arg("home"), port: Number(arg("port", "8899")) });
d.send({ type: "events.subscribe" });
const cdp = await connectPage(Number(arg("cdp", "9223")));
await installCursor(cdp);
console.log("[take1] rolling");
const rec = startRecording(cdp, path.join(out, "frames"), { maxWidth: 2880, maxHeight: 1800, format: "jpeg" });
await sleep(1500);

// S1 — type the ask into the New Session composer (clear any leftover draft first).
await clickText(cdp, "Sessions").catch(() => {}); // the "New session" button only exists on the Sessions tab
await sleep(600);
await clickText(cdp, "New session").catch(() => {}); // no-op if the page is already open
await sleep(800);
await clickSelector(cdp, '[contenteditable="true"]');
await cdp.eval(`document.execCommand("selectAll")`);
await sleep(300);
await typeText(cdp, ASK, { cps: 24 });
await sleep(900);
// ARM WAITERS BEFORE SENDING — master.status fires within ms of the Enter; arming after misses it.
const turnStarted = d.waitForEvent((e) => e.type === "master.status" && e.status === "running", { timeoutMs: 20000, label: "master turn start" });
const workerSpawn = d.waitForEvent(
  (e) => e.type === "worker.status" && ["provisioning", "running"].includes(e.status),
  { timeoutMs: 300000, label: "worker 1 spawn" },
);
await pressEnter(cdp);

// Confirm the turn actually started (else surface loudly — don't waste a take).
await turnStarted;
console.log("[take1] master running — waiting for it to spawn the worker");

// S1 climax: the master's spawn_worker materializes as a running worker.
const w1 = await workerSpawn;
console.log(`[take1] worker1: ${w1.workerId}`);
await sleep(8000); // let the tool card complete + worker chip render on camera

// S2 — second task lands (conductor-side, as if from another surface), then pan to the fleet.
await d.request({
  type: "fleet.spawn", repo: "orbitkit", label: "json output flag",
  task: "Add a --json flag to the orbitkit CLI that prints {changelogHtml, feedXml} to stdout instead of writing files. Update README usage, add a test, commit on your branch.",
  costBudgetUsd: 2,
});
await sleep(2500);
await clickText(cdp, "Repos");
await sleep(2000);
await clickText(cdp, "json output flag").catch(() => console.log("[take1] worker2 row not clickable yet"));
await sleep(9000); // streaming transcript on camera
await moveMouse(cdp, 1000, 400, { ms: 600 });
await sleep(4000);

const concat = await rec.stop();
console.log(`[take1] frames: ${rec.frames.length}`);
assembleMp4(path.join(out, "frames"), path.join(out, "take1.mp4"));
console.log(`[take1] ${path.join(out, "take1.mp4")}  (workers left running: ${w1.workerId} + json output flag)`);
cdp.close();
d.close();
