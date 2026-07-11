// Human-looking input synthesis over CDP: a visible synthetic cursor (the OS cursor is not
// part of the captured surface), eased mouse movement, click ripples, and paced typing.
import { sleep } from "./cdp.mjs";

// Inject a fake cursor that tracks real (CDP-dispatched) mousemove events, plus a click ripple.
export async function installCursor(cdp) {
  await cdp.eval(`(() => {
    if (window.__demoCursor) return;
    const style = document.createElement("style");
    style.textContent = \`
      #__demo_cursor { position: fixed; z-index: 2147483647; pointer-events: none; width: 22px; height: 22px;
        transform: translate(-3px, -2px); transition: none; }
      .__demo_ripple { position: fixed; z-index: 2147483646; pointer-events: none; width: 36px; height: 36px;
        margin: -18px 0 0 -18px; border-radius: 50%; border: 2px solid rgba(120,170,255,.9);
        animation: __demo_rip .45s ease-out forwards; }
      @keyframes __demo_rip { from { transform: scale(.3); opacity: .9 } to { transform: scale(1.4); opacity: 0 } }\`;
    document.head.appendChild(style);
    const c = document.createElement("div");
    c.id = "__demo_cursor";
    c.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M5 3l14 8.5-6.5 1L15 19l-2.6 1.2-2.5-6.6L5 17z" fill="#fff" stroke="#111" stroke-width="1.4"/></svg>';
    document.body.appendChild(c);
    window.addEventListener("mousemove", (e) => { c.style.left = e.clientX + "px"; c.style.top = e.clientY + "px"; }, true);
    window.addEventListener("mousedown", (e) => {
      const r = document.createElement("div");
      r.className = "__demo_ripple"; r.style.left = e.clientX + "px"; r.style.top = e.clientY + "px";
      document.body.appendChild(r); setTimeout(() => r.remove(), 500);
    }, true);
    window.__demoCursor = { x: 40, y: 40 };
    return true;
  })()`);
}

const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

export async function moveMouse(cdp, x, y, { ms = 350, steps = 24 } = {}) {
  const from = await cdp.eval("window.__demoCursor ?? {x:40,y:40}");
  for (let i = 1; i <= steps; i++) {
    const t = ease(i / steps);
    const cx = from.x + (x - from.x) * t;
    const cy = from.y + (y - from.y) * t;
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx, y: cy });
    await sleep(ms / steps);
  }
  await cdp.eval(`window.__demoCursor = {x:${x},y:${y}}; true`);
}

export async function click(cdp, x, y, opts = {}) {
  await moveMouse(cdp, x, y, opts);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await sleep(60);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  await sleep(120);
}

// Center of the first element matching `selector` (throws if absent or zero-sized).
export async function rectOf(cdp, selector) {
  const r = await cdp.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height };
  })()`);
  if (!r || (!r.w && !r.h)) throw new Error(`selector not found/visible: ${selector}`);
  return r;
}

export async function clickSelector(cdp, selector, opts = {}) {
  const { x, y } = await rectOf(cdp, selector);
  await click(cdp, x, y, opts);
}

// Find a clickable element by its visible text (buttons/links/menu rows), then click its center.
export async function clickText(cdp, text, opts = {}) {
  const r = await cdp.eval(`(() => {
    const want = ${JSON.stringify(text)};
    const nodes = [...document.querySelectorAll("button, a, [role=button], [role=tab], [role=menuitem]")];
    const el = nodes.find((n) => n.textContent?.trim().includes(want) && n.getBoundingClientRect().width > 0);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  })()`);
  if (!r) throw new Error(`clickable text not found: ${text}`);
  await click(cdp, r.x, r.y, opts);
}

// Paced typing into the focused element. insertText works for both <input> and contenteditable.
export async function typeText(cdp, text, { cps = 18, jitter = 0.5 } = {}) {
  for (const ch of text) {
    await cdp.send("Input.insertText", { text: ch });
    const base = 1000 / cps;
    await sleep(base * (1 - jitter / 2 + Math.random() * jitter));
  }
}

export async function pressEnter(cdp) {
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
}
