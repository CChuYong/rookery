import { describe, it, expect } from "vitest";
import { buildSourceTask } from "../src/renderer/lib/source.js";

describe("buildSourceTask", () => {
  it("builds a structured block + label", () => {
    const r = buildSourceTask({ provider: "linear", id: "1", identifier: "ABC-7", title: "Ship it", url: "https://l/ABC-7", body: "details" });
    expect(r.task).toBe("## ABC-7: Ship it\nhttps://l/ABC-7\n\ndetails");
    expect(r.label).toBe("ABC-7 Ship it");
  });
  it("omits body section when empty", () => {
    const r = buildSourceTask({ provider: "github", id: "9", identifier: "#9", title: "x", url: "https://g/9", body: "" });
    expect(r.task).toBe("## #9: x\nhttps://g/9");
  });
});
