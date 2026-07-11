// Pipeline smoke test + first-run walkthrough: records the app while driving
// consent → onboarding → Getting Started checklist, then assembles mp4 + GIF.
// Doubles as the reference example of a "scene driver" built on cdp/input/record.
//
// Usage: node scripts/demo/smoke.mjs --port 9223 --out /tmp/demo-smoke
import path from "node:path";
import { connectPage, sleep } from "./cdp.mjs";
import { installCursor, clickText, moveMouse } from "./input.mjs";
import { startRecording, assembleMp4, toGif } from "./record.mjs";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const out = arg("out", "/tmp/demo-smoke");
const cdp = await connectPage(Number(arg("port", "9223")));
console.log(`attached: ${cdp.target.title}`);

await installCursor(cdp);
const rec = startRecording(cdp, path.join(out, "frames"));
await sleep(800);

// Scene: first-run gates. Each clickText throws if the expected UI isn't there.
await clickText(cdp, "Accept & Continue");
await sleep(700);
await clickText(cdp, "Next");
await sleep(700);
await clickText(cdp, "Get started").catch(() => clickText(cdp, "Get Started"));
await sleep(1000);

// The Getting Started checklist should now be up with 4 items (auth/folder/session/worker).
const items = await cdp.eval(`[...document.querySelectorAll("div")].filter(d => d.className?.includes?.("rise-in")).length`);
const counter = await cdp.eval(`(() => {
  const el = [...document.querySelectorAll("span")].find(s => /^\\d\\/4$/.test(s.textContent?.trim() ?? ""));
  return el ? el.textContent.trim() : null;
})()`);
console.log(`checklist card present: ${items > 0}, counter: ${counter}`);

// Wiggle the cursor over the checklist so the recording shows it.
await moveMouse(cdp, 1200, 700, { ms: 500 });
await sleep(1500);

const concat = await rec.stop();
console.log(`frames: ${rec.frames.length} (${concat})`);
const mp4 = assembleMp4(path.join(out, "frames"), path.join(out, "smoke.mp4"));
const gif = toGif(mp4, path.join(out, "smoke.gif"), { width: 720 });
console.log(`mp4: ${mp4}\ngif: ${gif}`);
if (!counter) {
  console.error("FAIL: Getting Started checklist counter not found");
  process.exit(1);
}
cdp.close();
