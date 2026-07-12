// "Camera" post pipeline: composite the native-res window capture onto a warm backdrop
// (rounded corners + soft shadow) and fly an eased virtual camera over it — the zoom style of
// product demo films, generated headlessly with ffmpeg zoompan.
//
// Geometry: window WIN_W x WIN_H sits centered on a CANVAS_W x CANVAS_H backdrop (16:10, same
// as the 1440x900 output). Shots address CANVAS coordinates; helpers convert window coords.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const WIN_W = 2560, WIN_H = 1720;
export const CANVAS_W = 3200, CANVAS_H = 2000;
export const WIN_X = (CANVAS_W - WIN_W) / 2, WIN_Y = (CANVAS_H - WIN_H) / 2;
export const OUT_W = 1440, OUT_H = 900, FPS = 30;
const BG = "0xE7E3D8"; // warm paper backdrop
const RADIUS = 28;

// One-time rounded-rect alpha mask (white on black) via geq.
export function ensureMask(dir) {
  const p = path.join(dir, `mask-${WIN_W}x${WIN_H}-r${RADIUS}.png`);
  if (fs.existsSync(p)) return p;
  const r = RADIUS;
  const cond =
    `lt(X,${r})*lt(Y,${r})*gt(hypot(${r}-X,${r}-Y),${r})+` +
    `gt(X,${WIN_W - r})*lt(Y,${r})*gt(hypot(X-${WIN_W - r},${r}-Y),${r})+` +
    `lt(X,${r})*gt(Y,${WIN_H - r})*gt(hypot(${r}-X,Y-${WIN_H - r}),${r})+` +
    `gt(X,${WIN_W - r})*gt(Y,${WIN_H - r})*gt(hypot(X-${WIN_W - r},Y-${WIN_H - r}),${r})`;
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi",
    "-i", `color=c=white:s=${WIN_W}x${WIN_H}`,
    "-vf", `format=gray,geq=lum='if(${cond},0,255)'`,
    "-frames:v", "1", p], { stdio: "pipe" });
  return p;
}

// Piecewise-smoothstep expression through keyframes [{n, v}] (n = output frame index).
function eased(kfs, name) {
  let expr = String(kfs[kfs.length - 1].v);
  for (let i = kfs.length - 2; i >= 0; i--) {
    const a = kfs[i], b = kfs[i + 1];
    const u = `min(max((on-${a.n})/${Math.max(1, b.n - a.n)},0),1)`;
    const ss = `${u}*${u}*(3-2*${u})`;
    expr = `if(lt(on,${b.n}), ${a.v}+${(b.v - a.v).toFixed(6)}*${ss}, ${expr})`;
  }
  return expr; // eslint-disable-line no-unused-vars — name kept for debuggability
}

// shots: [{t, rect: [cx, cy, w] | "full"}] in canvas coords; t in seconds within the segment.
// Returns the zoompan filter string. Camera height follows the 16:10 output aspect.
export function cameraFilter(shots, durSec) {
  const kf = shots.map((s) => {
    const [cx, cy, w] = s.rect === "full" ? [CANVAS_W / 2, CANVAS_H / 2, CANVAS_W] : s.rect;
    const z = CANVAS_W / w;
    const vw = CANVAS_W / z, vh = CANVAS_H / z;
    const x = Math.min(Math.max(cx - vw / 2, 0), CANVAS_W - vw);
    const y = Math.min(Math.max(cy - vh / 2, 0), CANVAS_H - vh);
    return { n: Math.round(s.t * FPS), z, x, y };
  });
  const zx = eased(kf.map((k) => ({ n: k.n, v: k.z })), "z");
  const xx = eased(kf.map((k) => ({ n: k.n, v: k.x })), "x");
  const yx = eased(kf.map((k) => ({ n: k.n, v: k.y })), "y");
  const frames = Math.round(durSec * FPS);
  return `zoompan=z='${zx}':x='${xx}':y='${yx}':d=1:s=${OUT_W}x${OUT_H}:fps=${FPS}`;
}

// Render one segment: trim [start,end) of input, blur the account-usage region, composite, camera.
export function renderSegment({ input, start, end, out, shots, maskDir, speed = 1 }) {
  const mask = ensureMask(maskDir);
  const dur = (end - start) / speed;
  const setpts = speed !== 1 ? `,setpts=PTS/${speed}` : "";
  const filter = [
    // usage gauge blur (window-native coords), then normalize to CFR for frame-indexed camera math
    `[0:v]trim=${start}:${end},setpts=PTS-STARTPTS${setpts},fps=${FPS},` +
      `split[w0][wb];[wb]crop=690:310:0:1345,boxblur=14[bl];[w0][bl]overlay=0:1345[win]`,
    `[1:v]format=gray,loop=-1:1:0[am]`,
    `[win][am]alphamerge[winA]`,
    // soft shadow = the same mask, blackened + blurred, under the window
    // r must match FPS — lavfi color defaults to 25fps and, as the overlay's main input, would
    // drag the whole graph to 25fps while zoompan restamps at FPS (burned a render: 5/6 duration).
    `color=c=black:s=${WIN_W}x${WIN_H}:r=${FPS},format=rgba,colorchannelmixer=aa=0.30[shsrc]`,
    `[shsrc][am]alphamerge,boxblur=32[sh]`,
    `color=c=${BG}:s=${CANVAS_W}x${CANVAS_H}:d=${dur.toFixed(3)}:r=${FPS}[bg]`,
    `[bg][sh]overlay=${WIN_X + 14}:${WIN_Y + 30}:shortest=1[b1]`,
    `[b1][winA]overlay=${WIN_X}:${WIN_Y}:shortest=1[canvas]`,
    `[canvas]${cameraFilter(shots, dur)}[out]`,
  ].join(";");
  execFileSync("ffmpeg", ["-y", "-v", "error", "-i", input, "-i", mask,
    "-filter_complex", filter, "-map", "[out]",
    "-c:v", "libx264", "-crf", "17", "-pix_fmt", "yuv420p", "-an", out], { stdio: "pipe" });
  return out;
}

// Convert a rect in WINDOW pixels to a camera shot rect [cx, cy, w] on the canvas.
export function winRect(x, y, w, h, padScale = 1.25) {
  const cx = WIN_X + x + w / 2;
  const cy = WIN_Y + y + h / 2;
  // pick camera width from the larger of rect width or aspect-corrected height, padded
  const needW = Math.max(w, h * (OUT_W / OUT_H)) * padScale;
  return [cx, cy, Math.min(needW, CANVAS_W)];
}
