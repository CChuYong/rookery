import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";

// The global keyboard-focus outline in globals.css is unlayered, so it beats Tailwind utilities. Browsers report
// text-entry controls as :focus-visible even on a mouse click, so the rule must exclude them (they show focus via
// their own border/ring), while every other interactive element keeps the orange outline.
const css = readFileSync(fileURLToPath(new NodeURL("../src/renderer/globals.css", import.meta.url)), "utf8");

function focusOutlineSelector(): string {
  const m = /([^{}]+?)\{\s*outline:\s*2px solid var\(--color-accent-hi\);/m.exec(css.replace(/\/\*[\s\S]*?\*\//g, ""));
  if (!m) throw new Error("focus outline rule not found");
  return m[1]!.trim();
}

function el(html: string): Element {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  return host.firstElementChild!;
}

// Top-level items of `:where(a, b, c):focus-visible`. jsdom cannot evaluate :focus-visible and mis-evaluates long
// :where() lists, so each item is matched on its own (an element gets the outline if any item matches).
function whereItems(selector: string): string[] {
  const m = /^:where\(([\s\S]*)\):focus-visible$/.exec(selector.replace(/\s+/g, " ").trim());
  if (!m) throw new Error(`unexpected selector shape: ${selector}`);
  const items: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of m[1]!) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { items.push(cur.trim()); cur = ""; } else cur += ch;
  }
  items.push(cur.trim());
  return items;
}

describe("global :focus-visible outline", () => {
  const selector = focusOutlineSelector();
  const items = whereItems(selector);
  const outlined = (e: Element): boolean => items.some((it) => e.matches(it));

  it("is still keyed on :focus-visible (keyboard focus only)", () => {
    expect(selector).toContain(":focus-visible");
  });

  it.each([
    ["<button>b</button>"],
    ['<a href="#">a</a>'],
    ['<div role="button" tabindex="0">r</div>'],
    ['<div role="tab" tabindex="0">t</div>'],
    ["<select><option>o</option></select>"],
    ["<summary>s</summary>"],
    ['<input type="checkbox">'],
    ['<input type="radio">'],
    ['<input type="range">'],
    ['<input type="color">'],
    ['<input type="file">'],
    ['<input type="submit">'],
    ['<div tabindex="0">tree</div>'],
  ])("keeps the outline on %s", (html) => {
    expect(outlined(el(html))).toBe(true);
  });

  it.each([
    ["<input>"],
    ['<input type="text">'],
    ['<input type="search">'],
    ['<input type="password">'],
    ['<input type="number">'],
    ['<input role="combobox">'],
    ["<textarea></textarea>"],
    ['<textarea tabindex="0"></textarea>'],
    ['<div contenteditable="true" role="textbox"></div>'],
    ['<div contenteditable="true" tabindex="0"></div>'],
    ['<div contenteditable="" tabindex="0"></div>'],
  ])("drops the outline on text-entry %s", (html) => {
    expect(outlined(el(html))).toBe(false);
  });
});
