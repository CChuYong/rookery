// Take 4 — scene 5: the attention bell ranks what needs you; click through to the finished
// worker, open its commit diff. Usage: node scripts/demo/shoot-s5.mjs --cdp 9223 --out <dir>
import path from "node:path";
import { connectPage, sleep } from "./cdp.mjs";
import { installCursor, clickText, clickSelector } from "./input.mjs";
import { startRecording, assembleMp4 } from "./record.mjs";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const out = arg("out", "/tmp/demo-take4");
const cdp = await connectPage(Number(arg("cdp", "9223")));
await installCursor(cdp);
console.log("[take4] rolling (attention bell)");
const rec = startRecording(cdp, path.join(out, "frames"), { maxWidth: 2560, maxHeight: 1800, format: "jpeg" });
await sleep(1500);

try {
  await clickSelector(cdp, '[aria-label^="Attention queue"]');
  await sleep(2800); // the ranked "Needs you now" queue on camera
  // Top-ranked row → navigate to that surface.
  await clickSelector(cdp, '[aria-label="Needs you now"] button, [aria-label="Needs you now"] [role="button"]')
    .catch(() => clickText(cdp, "orbitkit"));
  await sleep(3000);

  // The shipped work: worker's Git panel → History → the commit diff.
  await clickText(cdp, "Add --json flag to CLI").catch(() => {});
  await sleep(1500);
  await clickText(cdp, "Git");
  await sleep(1200);
  await clickText(cdp, "History");
  await sleep(1500);
  // Open the top commit (its row includes the short subject from the worker's commit).
  await clickText(cdp, "json").catch(() => console.log("[take4] commit row not matched"));
  await sleep(6000); // diff on camera
} finally {
  await rec.stop().catch((e) => console.error(`[take4] stop failed: ${e.message}`));
  console.log(`[take4] frames: ${rec.frames.length}`);
  assembleMp4(path.join(out, "frames"), path.join(out, "take4.mp4"));
  console.log(`[take4] ${path.join(out, "take4.mp4")}`);
  cdp.close();
}
