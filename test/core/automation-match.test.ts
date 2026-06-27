import { describe, it, expect } from "vitest";
import { matchesSlack } from "../../src/core/automation-match.js";

const ev = (o: Partial<{ channel: string; userId: string; text: string }> = {}) => ({ channel: "C1", userId: "U1", text: "deploy failed in prod", ...o });

describe("matchesSlack", () => {
  it("empty filters match everything", () => { expect(matchesSlack({ kind: "slack" }, ev())).toBe(true); });
  it("channel filter", () => {
    expect(matchesSlack({ kind: "slack", channels: ["C1"] }, ev())).toBe(true);
    expect(matchesSlack({ kind: "slack", channels: ["C2"] }, ev())).toBe(false);
  });
  it("keyword is case-insensitive substring", () => {
    expect(matchesSlack({ kind: "slack", keyword: "DEPLOY" }, ev())).toBe(true);
    expect(matchesSlack({ kind: "slack", keyword: "rollback" }, ev())).toBe(false);
  });
  it("fromUsers filter", () => {
    expect(matchesSlack({ kind: "slack", fromUsers: ["U1"] }, ev())).toBe(true);
    expect(matchesSlack({ kind: "slack", fromUsers: ["U9"] }, ev({ userId: "U1" }))).toBe(false);
  });
  it("all filters AND together", () => {
    expect(matchesSlack({ kind: "slack", channels: ["C1"], keyword: "deploy", fromUsers: ["U1"] }, ev())).toBe(true);
    expect(matchesSlack({ kind: "slack", channels: ["C1"], keyword: "nope" }, ev())).toBe(false);
  });
});
