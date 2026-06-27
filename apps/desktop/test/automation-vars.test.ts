import { describe, it, expect } from "vitest";
import { referencedVars } from "../src/renderer/lib/automation-vars.js";

describe("referencedVars", () => {
  it("extracts known {{vars}} in order, deduped", () => {
    expect(referencedVars("hi {{message}} from {{user}}, again {{message}}")).toEqual(["message", "user"]);
  });
  it("ignores unknown tokens and returns [] when none", () => {
    expect(referencedVars("plain text {{unknown}} {{foo}}")).toEqual([]);
    expect(referencedVars("")).toEqual([]);
  });
  it("matches all six known vars", () => {
    expect(referencedVars("{{message}}{{channel}}{{user}}{{ts}}{{threadTs}}{{team}}")).toEqual(["message","channel","user","ts","threadTs","team"]);
  });
});
