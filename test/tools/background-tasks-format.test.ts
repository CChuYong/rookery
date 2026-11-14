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
});
