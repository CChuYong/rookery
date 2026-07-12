// Take 2 — scene 3: the app was closed (caller kills/relaunches it); film the RESTORE —
// sessions/transcripts/fleet all back, workers finished while the window was gone.
// Run right after relaunching the app: node scripts/demo/shoot-s3.mjs --cdp 9223 --out <dir>
import path from "node:path";
import { connectPage, sleep } from "./cdp.mjs";
import { installCursor, clickText, moveMouse } from "./input.mjs";
import { startRecording, assembleMp4 } from "./record.mjs";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const out = arg("out", "/tmp/demo-take2");
const cdp = await connectPage(Number(arg("cdp", "9223")));
await installCursor(cdp);
console.log("[take2] rolling (restore)");
const rec = startRecording(cdp, path.join(out, "frames"), { maxWidth: 1440 });
await sleep(2500); // the freshly-reopened window, sessions restoring

await clickText(cdp, "Sessions").catch(() => {});
await sleep(800);
await clickText(cdp, "orbitkit"); // the session created on camera in take 1
await sleep(3500); // transcript (tools/thinking included) restores on screen

await clickText(cdp, "Repos");
await sleep(3000); // fleet: both workers finished + costs, while the app was closed
await moveMouse(cdp, 260, 320, { ms: 600 });
await sleep(2500);

await rec.stop();
console.log(`[take2] frames: ${rec.frames.length}`);
assembleMp4(path.join(out, "frames"), path.join(out, "take2.mp4"));
console.log(`[take2] ${path.join(out, "take2.mp4")}`);
cdp.close();
