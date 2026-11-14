import { describe, it, expect } from "vitest";
import * as daemon from "@daemon/core/image-input.js";
import { IMAGE_LIMITS, validateImageRefs } from "../src/renderer/lib/image-limits.js";

// The renderer keeps its own copy of the image bounds (it must not runtime-import daemon code). This pins the copy
// to the daemon's values so the composer never accepts something the daemon will reject, or vice versa.
const ok = { id: "123e4567-e89b-42d3-a456-426614174000", name: "a.png", mediaType: "image/png" as const, byteLength: 1024, width: 10, height: 10 };

describe("renderer image limits mirror the daemon", () => {
  it("has the same per-message bounds", () => {
    for (const key of Object.keys(IMAGE_LIMITS) as Array<keyof typeof IMAGE_LIMITS>) {
      expect(IMAGE_LIMITS[key]).toBe(daemon.IMAGE_LIMITS[key]);
    }
  });

  it.each([
    ["valid", [ok]],
    ["too many", Array.from({ length: 5 }, () => ok)],
    ["bad id", [{ ...ok, id: "../etc" }]],
    ["bad type", [{ ...ok, mediaType: "image/svg+xml" }]],
    ["too large", [{ ...ok, byteLength: 3 * 1024 * 1024 + 1 }]],
    ["too wide", [{ ...ok, width: 8001 }]],
    ["message total", Array.from({ length: 3 }, () => ({ ...ok, byteLength: 3 * 1024 * 1024 }))],
  ])("agrees on %s", (_name, refs) => {
    const run = (fn: (r: never) => unknown) => {
      try { fn(refs as never); return "ok"; } catch (e) { return (e as Error).message; }
    };
    expect(run(validateImageRefs as never)).toBe(run(daemon.validateImageRefs as never));
  });
});
