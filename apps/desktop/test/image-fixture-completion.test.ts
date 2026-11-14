import { expect, it } from "vitest";
import path from "node:path";
import { pathToFileURL } from "node:url";
it.each(["master", "worker", "side"])(
  "synthetic %s completion supplies running, assistant, result and idle",
  async (kind) => {
    const { completionEvents } = await import(
      pathToFileURL(
        path.resolve(process.cwd(), "../../scripts/demo/images/completion.mjs"),
      ).href
    );
    const events = completionEvents({
      kind,
      id: "target",
      sourceId: "source",
      sourceKind: "worker",
      provider: "codex",
      speed: "fast",
    });
    expect(events[0].status).toBe("running");
    expect(events.at(-1).status).toBe("idle");
    const assistant = events.find(
      (event: Record<string, unknown>) =>
        (event.data ?? (event as any)).role === "assistant",
    );
    expect(assistant).toBeDefined();
    const result = events.find(
      (event: Record<string, unknown>) =>
        (event.data as any)?.kind === "result" ||
        event.type === "master.result",
    );
    expect(result.data ?? result).toMatchObject({
      costAccuracy: "estimated",
      requestedSpeed: "fast",
    });
    expect(JSON.stringify(events)).not.toContain("base64");
  },
);
