// Take 3 — scene 4: camera on the fleet while a follow-up lands on worker 1; it re-settles and
// the worker-settled automation spawns a reviewer on its own. Requires the automation ENABLED.
// Usage: node scripts/demo/shoot-s4.mjs --home <demo-home> --port 8899 --cdp 9223 --out <dir> --worker <id>
import path from "node:path";
import { connectPage, sleep } from "./cdp.mjs";
import { installCursor, clickText } from "./input.mjs";
import { startRecording, assembleMp4 } from "./record.mjs";
import { connectDaemon } from "./daemon-ws.mjs";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const out = arg("out", "/tmp/demo-take3");
const workerId = arg("worker");

const d = await connectDaemon({ home: arg("home"), port: Number(arg("port", "8899")) });
d.send({ type: "events.subscribe" });
const cdp = await connectPage(Number(arg("cdp", "9223")));
await installCursor(cdp);
console.log("[take3] rolling (fleet view)");
const rec = startRecording(cdp, path.join(out, "frames"), { maxWidth: 1440 });
await sleep(1000);
await clickText(cdp, "Repos").catch(() => {});
await sleep(2000);

// ARM ALL WAITERS BEFORE SENDING — worker.status fires the moment the send lands, so a waiter
// armed after the ack races and can miss it (burned take 3a exactly this way).
const ranOnce = d.waitForEvent((e) => e.type === "worker.status" && e.workerId === workerId && e.status === "running", { timeoutMs: 60000, label: "worker running" });
const settled = d.waitForEvent((e) => e.type === "worker.status" && e.workerId === workerId && e.status === "idle", { timeoutMs: 300000, label: "worker idle" });
const reviewerSpawn = d.waitForEvent(
  (e) => e.type === "worker.status" && e.workerId !== workerId && ["provisioning", "running"].includes(e.status),
  { timeoutMs: 420000, label: "reviewer spawn" },
);

try {
  const text = arg("text", "Run node --test one more time and summarize the result in one line.");
  await d.request({ type: "worker.send", id: workerId, text });
  console.log("[take3] follow-up sent — waiting for re-settle");
  await ranOnce;
  await settled;
  console.log("[take3] settled — waiting for the reviewer to auto-spawn");
  const reviewer = await reviewerSpawn;
  console.log(`[take3] reviewer: ${reviewer.workerId}`);
  await sleep(6000); // reviewer row appears + starts running on camera

  // Peek into the reviewer's transcript while it reads the diff.
  await clickText(cdp, "Review").catch(() => console.log("[take3] reviewer row label not found — staying on fleet"));
  await sleep(12000);
} finally {
  // Salvage the footage even on a timeout — a partial take is still cuttable.
  await rec.stop().catch((e) => console.error(`[take3] stop failed: ${e.message}`));
  console.log(`[take3] frames: ${rec.frames.length}`);
  assembleMp4(path.join(out, "frames"), path.join(out, "take3.mp4"));
  console.log(`[take3] ${path.join(out, "take3.mp4")}`);
  cdp.close();
  d.close();
}
