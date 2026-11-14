// Synthetic completion frames only. No provider or application runtime is invoked.
export function completionEvents({
  kind,
  id,
  sourceId = "aabbccdd",
  sourceKind = "master",
  provider = "claude",
  speed = "standard",
}) {
  const message = {
    kind: "message",
    role: "assistant",
    content: "Synthetic fixture completed. No provider was called.",
  };
  const result = {
    kind: "result",
    subtype: "success",
    costUsd: 0,
    costAccuracy: provider === "codex" ? "estimated" : "reported",
    requestedSpeed: speed,
    numTurns: 1,
    durationMs: 1,
    contextTokens: 0,
    contextWindow: 200000,
  };
  const observation = { requested: speed, state: "unknown" };
  if (kind === "master")
    return [
      { type: "master.status", sessionId: id, status: "running" },
      { type: "master.speed", sessionId: id, observation },
      {
        type: "master.message",
        sessionId: id,
        role: message.role,
        content: message.content,
      },
      {
        type: "master.result",
        sessionId: id,
        ...Object.fromEntries(
          Object.entries(result).filter(([key]) => key !== "kind"),
        ),
      },
      { type: "master.status", sessionId: id, status: "idle" },
    ];
  if (kind === "worker")
    return [
      {
        type: "worker.status",
        sessionId: sourceId,
        workerId: id,
        status: "running",
      },
      ...[{ kind: "speed", observation }, message, result].map((data) => ({
        type: "worker.event",
        sessionId: sourceId,
        workerId: id,
        data,
      })),
      {
        type: "worker.status",
        sessionId: sourceId,
        workerId: id,
        status: "idle",
      },
    ];
  const common = { sideId: id, sourceId, sourceKind };
  return [
    { type: "side.status", ...common, status: "running" },
    ...[{ kind: "speed", observation }, message, result].map((data) => ({
      type: "side.event",
      ...common,
      data,
    })),
    { type: "side.status", ...common, status: "idle" },
  ];
}
