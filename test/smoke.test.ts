import { describe, it, expect } from "vitest";
import { ping } from "../src/smoke.js";

describe("toolchain smoke", () => {
  it("resolves .js import to .ts and runs", () => {
    expect(ping()).toBe("pong");
  });
});
