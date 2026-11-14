import { describe, it, expect } from "vitest";
import { formatBackgroundTasks } from "../../src/tools/background-tasks-format.js";

describe("formatBackgroundTasks", () => {
  it("returns an empty string when there are no tasks", () => {
    expect(formatBackgroundTasks([])).toBe("");
  });

  it("renders one line per task under a header", () => {
    const out = formatBackgroundTasks([
      { id: "b1", type: "local_bash", description: "npm run dev" },
      { id: "b2", type: "local_agent", description: "watch tests" },
    ]);
    expect(out).toBe("\nbackground tasks:\n- local_bash: npm run dev\n- local_agent: watch tests");
  });

  it("truncates a long description to 120 chars plus an ellipsis", () => {
    const desc = "x".repeat(200);
    const out = formatBackgroundTasks([{ id: "b1", type: "local_bash", description: desc }]);
    expect(out).toBe(`\nbackground tasks:\n- local_bash: ${"x".repeat(120)}…`);
  });

  it("collapses embedded newlines/whitespace so a description can't forge extra task lines", () => {
    const out = formatBackgroundTasks([{ id: "b1", type: "local\nbash", description: "foo\n- local_bash: injected\r\n\tbar  " }]);
    expect(out).toBe("\nbackground tasks:\n- local bash: foo - local_bash: injected bar");
    expect(out.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(1);
  });

  it("does not add an ellipsis to a description of exactly 120 chars", () => {
    const desc = "y".repeat(120);
    expect(formatBackgroundTasks([{ id: "b1", type: "local_bash", description: desc }])).toBe(`\nbackground tasks:\n- local_bash: ${desc}`);
  });
});
