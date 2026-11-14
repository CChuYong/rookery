import { describe, it, expect, vi } from "vitest";
import { validateImageRefs, IMAGE_LIMITS } from "../../src/core/image-input.js";
import {
  claudeUserMessages,
  ClaudeBackend,
  type QueryFn,
} from "../../src/core/claude-backend.js";
import { fakeQuery } from "../helpers/fake-query.js";
const image = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  name: "a.png",
  mediaType: "image/png" as const,
  byteLength: 3 * 1024 * 1024,
  width: 1,
  height: 1,
};
describe("image input bounds", () => {
  it("accepts image-only and rejects count, bytes and invalid ids", () => {
    expect(validateImageRefs([image])).toEqual([image]);
    expect(() => validateImageRefs(Array(5).fill(image))).toThrow();
    expect(() => validateImageRefs(Array(3).fill(image))).toThrow();
    expect(() => validateImageRefs([{ ...image, id: "../x" }])).toThrow();
    expect(IMAGE_LIMITS.wsBytes).toBe(16 * 1024 * 1024);
  });
});

it("Claude emits native blocks for a finite single-image turn and preserves text-only strings", async () => {
  const prompt = {
    text: "",
    images: [{ mediaType: "image/png" as const, data: "aGVsbG8=" }],
  };
  async function* inputs() {
    yield prompt;
  }
  const messages = [];
  for await (const message of claudeUserMessages(inputs()))
    messages.push(message);
  expect(messages).toEqual([
    {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "aGVsbG8=",
            },
          },
        ],
      },
      parent_tool_use_id: null,
    },
  ]);
  const seen: unknown[] = [];
  const capture: QueryFn = (args) => {
    seen.push(args.prompt);
    return fakeQuery([
      {
        type: "result",
        subtype: "success",
        total_cost_usd: 0,
        num_turns: 1,
        session_id: "sdk",
      },
    ])(args);
  };
  const backend = new ClaudeBackend(capture);
  const options = {
    cwd: "/tmp",
    model: "m",
    permissionMode: "default",
    abortController: new AbortController(),
  };
  for await (const _ of backend.startTurn(prompt, options)) {
    /* finish */
  }
  const finite = [];
  for await (const message of seen[0] as AsyncIterable<unknown>)
    finite.push(message);
  expect(finite).toEqual(messages);
  for await (const _ of backend.startTurn("text", options)) {
    /* finish */
  }
  expect(seen[1]).toBe("text");
});

it("real SDK finite image input reaches terminal result and resumes with a native block", async () => {
  const { sdkQueryProcess } = await import("../helpers/sdk-query-process.js");
  const sdk = sdkQueryProcess();
  const backend = new ClaudeBackend(sdk.queryFn);
  const options = {
    cwd: "/tmp",
    model: "m",
    permissionMode: "default",
    abortController: new AbortController(),
  };
  try {
    for (const resume of [undefined, "sdk-process-test"]) {
      const events = [];
      for await (const event of backend.startTurn(
        {
          text: "describe",
          images: [{ mediaType: "image/png", data: "eHl6" }],
        },
        { ...options, resume, canUseTool: async () => ({ behavior: "allow" }) },
      ))
        events.push(event);
      expect(events.some((e) => e.kind === "turn_end")).toBe(true);
    }
    expect(sdk.delivered).toEqual(
      Array(2).fill([
        { type: "text", text: "describe" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "eHl6" },
        },
      ]),
    );
  } finally {
    sdk.close();
  }
}, 5000);

it("real SDK image turn cancellation and process failures keep distinct caller abort state", async () => {
  const { sdkQueryProcess } = await import("../helpers/sdk-query-process.js");
  for (const failUser of [false, true]) {
    const sdk = sdkQueryProcess({ holdUser: !failUser, failUser });
    const abortController = new AbortController();
    try {
      const stream = new ClaudeBackend(sdk.queryFn).startTurn(
        { text: "", images: [{ mediaType: "image/png", data: "eHl6" }] },
        {
          cwd: "/tmp",
          model: "m",
          permissionMode: "default",
          abortController,
          canUseTool: async () => ({ behavior: "allow" }),
        },
      );
      const result = (async () => {
        for await (const _ of stream) {
          /* drain */
        }
      })();
      const settled = result.then(
        () => undefined,
        (error) => error,
      );
      await vi.waitFor(() => expect(sdk.delivered).toHaveLength(1));
      if (!failUser) abortController.abort();
      expect(await settled).toBeInstanceOf(Error);
      expect(abortController.signal.aborted).toBe(!failUser);
    } finally {
      sdk.close();
    }
  }
}, 5000);

it("accepts four refs at 8 MiB and rejects larger aggregate metadata", () => {
  const ref = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    name: "a.png",
    mediaType: "image/png" as const,
    byteLength: 2 * 1024 * 1024,
    width: 1,
    height: 1,
  };
  expect(validateImageRefs(Array(4).fill(ref))).toHaveLength(4);
  expect(() =>
    validateImageRefs([
      { ...ref, byteLength: ref.byteLength + 1 },
      ref,
      ref,
      ref,
    ]),
  ).toThrow("8 MiB");
});
