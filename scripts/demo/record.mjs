// Screencast recorder: captures CDP Page.startScreencast frames and assembles them
// into an mp4 (and optionally a palette-optimized GIF) with ffmpeg.
// Frames arrive only on repaint, so assembly uses per-frame durations (concat demuxer, vfr).
//
// CLI smoke test:  node scripts/demo/record.mjs --port 9223 --seconds 10 --out /tmp/demo-rec
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { connectPage, sleep } from "./cdp.mjs";

export function startRecording(cdp, outDir, { maxWidth = 1440, maxHeight = 1024, format = "png", quality = 92 } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const ext = format === "jpeg" ? "jpg" : "png";
  const frames = []; // { file, ts }
  let n = 0;
  const off = cdp.on("Page.screencastFrame", (p) => {
    const file = path.join(outDir, `frame-${String(n++).padStart(6, "0")}.${ext}`);
    fs.writeFileSync(file, Buffer.from(p.data, "base64"));
    frames.push({ file, ts: p.metadata.timestamp });
    void cdp.send("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => {});
  });
  // jpeg at high quality is ~5-8x smaller than png — use it for native-resolution takes.
  void cdp.send("Page.startScreencast", { format, ...(format === "jpeg" ? { quality } : {}), everyNthFrame: 1, maxWidth, maxHeight });

  return {
    frames,
    // Stop capturing and write the ffmpeg concat list (per-frame real durations).
    async stop() {
      await cdp.send("Page.stopScreencast").catch(() => {});
      off();
      if (frames.length === 0) throw new Error("no frames captured — was the window visible/repainting?");
      const lines = ["ffconcat version 1.0"];
      for (let i = 0; i < frames.length; i++) {
        const dur = i + 1 < frames.length ? Math.max(0.001, frames[i + 1].ts - frames[i].ts) : 0.5;
        lines.push(`file '${path.basename(frames[i].file)}'`, `duration ${dur.toFixed(4)}`);
      }
      // concat demuxer quirk: repeat the last file so its duration is honored
      lines.push(`file '${path.basename(frames[frames.length - 1].file)}'`);
      const concatPath = path.join(outDir, "frames.concat");
      fs.writeFileSync(concatPath, lines.join("\n") + "\n");
      return concatPath;
    },
  };
}

export function assembleMp4(outDir, mp4Path, { crf = 18 } = {}) {
  execFileSync("ffmpeg", [
    "-y", "-f", "concat", "-safe", "0", "-i", path.join(outDir, "frames.concat"),
    "-fps_mode", "vfr", "-pix_fmt", "yuv420p",
    // libx264 requires even dimensions; pad by one pixel if needed
    "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2",
    "-c:v", "libx264", "-crf", String(crf), mp4Path,
  ], { stdio: "pipe" });
  return mp4Path;
}

// High-quality GIF via two-pass palettegen/paletteuse. Trim/speed edits should happen on the mp4 first.
export function toGif(mp4Path, gifPath, { fps = 12, width = 920 } = {}) {
  const filter = `[0:v] fps=${fps},scale=${width}:-1:flags=lanczos,split [a][b];[a] palettegen=stats_mode=diff [p];[b][p] paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`;
  execFileSync("ffmpeg", ["-y", "-i", mp4Path, "-filter_complex", filter, gifPath], { stdio: "pipe" });
  return gifPath;
}

// ---- CLI smoke mode ----
const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (isMain) {
  const arg = (name, dflt) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 ? process.argv[i + 1] : dflt;
  };
  const port = Number(arg("port", "9223"));
  const seconds = Number(arg("seconds", "10"));
  const outDir = arg("out", "/tmp/demo-rec");
  const cdp = await connectPage(port);
  console.log(`attached to: ${cdp.target.title} (${cdp.target.url})`);
  const rec = startRecording(cdp, outDir);
  console.log(`recording ${seconds}s → ${outDir}`);
  await sleep(seconds * 1000);
  await rec.stop();
  const mp4 = assembleMp4(outDir, path.join(outDir, "out.mp4"));
  console.log(`frames: ${rec.frames.length}\nmp4: ${mp4}`);
  cdp.close();
}
