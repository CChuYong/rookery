import { describe, it, expect } from "vitest";
import { askUserQuestionDef } from "../../src/tools/ask-user-question-def.js";
import type { AskChannelResult } from "../../src/tools/ask-user-question-def.js";

const SAMPLE_INPUT = {
  questions: [
    { question: "Which library?", header: "Library", options: [{ label: "date-fns" }, { label: "luxon", description: "heavier but timezone-aware" }] },
  ],
};

describe("askUserQuestionDef", () => {
  it("is named exactly \"AskUserQuestion\"", () => {
    const def = askUserQuestionDef(async () => ({ behavior: "allow" }));
    expect(def.name).toBe("AskUserQuestion");
  });

  it("allow-path: surfaces the resolved answers as serialized text content", async () => {
    const resolved: AskChannelResult = {
      behavior: "allow",
      updatedInput: { questions: SAMPLE_INPUT.questions, answers: { "Which library?": "date-fns" } },
    };
    const def = askUserQuestionDef(async () => resolved);
    const result = await def.handler(SAMPLE_INPUT as never, undefined);
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ "Which library?": "date-fns" }) }]);
  });

  it("allow-path: falls back to the whole updatedInput when there is no nested answers field", async () => {
    const def = askUserQuestionDef(async () => ({ behavior: "allow", updatedInput: { foo: "bar" } }));
    const result = await def.handler(SAMPLE_INPUT as never, undefined);
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ foo: "bar" }) }]);
  });

  it("allow-path: falls back to {} when updatedInput is entirely absent", async () => {
    const def = askUserQuestionDef(async () => ({ behavior: "allow" }));
    const result = await def.handler(SAMPLE_INPUT as never, undefined);
    expect(result.content).toEqual([{ type: "text", text: "{}" }]);
  });

  it("deny-path: isError true and the denial message is included", async () => {
    const def = askUserQuestionDef(async () => ({ behavior: "deny", message: "nope" }));
    const result = await def.handler(SAMPLE_INPUT as never, undefined);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("nope");
  });

  it("deny-path: tolerates a missing message", async () => {
    const def = askUserQuestionDef(async () => ({ behavior: "deny" }));
    const result = await def.handler(SAMPLE_INPUT as never, undefined);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("question denied/unanswered");
  });

  it("passes the raw args through to the injected ask channel unchanged", async () => {
    let seen: unknown;
    const def = askUserQuestionDef(async (input) => {
      seen = input;
      return { behavior: "allow", updatedInput: { answers: {} } };
    });
    await def.handler(SAMPLE_INPUT as never, undefined);
    expect(seen).toEqual(SAMPLE_INPUT);
  });
});
