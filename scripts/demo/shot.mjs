// One-off screenshot of the app window via CDP — for storyboard/scene checks.
// Usage: node scripts/demo/shot.mjs --port 9223 --out /tmp/shot.png
import fs from "node:fs";
import { connectPage } from "./cdp.mjs";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const cdp = await connectPage(Number(arg("port", "9223")));
const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
const out = arg("out", "/tmp/shot.png");
fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
console.log(`${cdp.target.title} → ${out}`);
cdp.close();
