import { describe, it, expect } from "vitest";
import { parseClientMessage, serializeServerMessage, clientMessageSchema } from "../../src/protocol/messages.js";
import type { ServerMessage } from "../../src/protocol/messages.js";

describe("protocol v2 client messages", () => {
  it("parses one authoritative command target and rejects ambiguous targets", () => {
    expect(parseClientMessage(JSON.stringify({ type: "commands.list", reqId: "c1", sessionId: "s1", cwd: "/spoof", provider: "codex" }))).toEqual({
      type: "commands.list", reqId: "c1", sessionId: "s1", cwd: "/spoof", provider: "codex",
    });
    expect(parseClientMessage(JSON.stringify({ type: "commands.list", reqId: "c2", workerId: "w1" }))).toEqual({
      type: "commands.list", reqId: "c2", workerId: "w1",
    });
    expect(() => parseClientMessage(JSON.stringify({ type: "commands.list", reqId: "c3", sessionId: "s1", workerId: "w1" }))).toThrow();
  });

  it("parses live and preview capability targets and rejects injected preview authority", () => {
    expect(parseClientMessage(JSON.stringify({ type: "capabilities.snapshot", reqId: "c1", target: { kind: "session", id: "s1" } }))).toEqual({
      type: "capabilities.snapshot", reqId: "c1", target: { kind: "session", id: "s1" },
    });
    expect(parseClientMessage(JSON.stringify({ type: "capabilities.snapshot", reqId: "c2", target: { kind: "worker", id: "w1" } }))).toEqual({
      type: "capabilities.snapshot", reqId: "c2", target: { kind: "worker", id: "w1" },
    });
    expect(parseClientMessage(JSON.stringify({ type: "capabilities.snapshot", reqId: "c3", target: { kind: "rookery", provider: "claude", agent: "master" } }))).toEqual({
      type: "capabilities.snapshot", reqId: "c3", target: { kind: "rookery", provider: "claude", agent: "master" },
    });
    expect(parseClientMessage(JSON.stringify({ type: "capabilities.snapshot", reqId: "c4", target: { kind: "repo", id: "r1", provider: "codex", agent: "worker" } }))).toEqual({
      type: "capabilities.snapshot", reqId: "c4", target: { kind: "repo", id: "r1", provider: "codex", agent: "worker" },
    });
    expect(() => parseClientMessage(JSON.stringify({ type: "capabilities.snapshot", reqId: "c5", target: { kind: "repo", id: "r1" } }))).toThrow();
    expect(() => parseClientMessage(JSON.stringify({ type: "capabilities.snapshot", reqId: "c6", target: { kind: "repo", id: "r1", provider: "claude", agent: "master", cwd: "/tmp/injected" } }))).toThrow();
    expect(() => parseClientMessage(JSON.stringify({ type: "capabilities.snapshot", reqId: "c7", target: { kind: "rookery", provider: "codex", agent: "worker", origin: "slack" } }))).toThrow();
    expect(() => parseClientMessage(JSON.stringify({ type: "capabilities.snapshot", reqId: "c8", target: { kind: "session", id: "" } }))).toThrow();
    expect(() => parseClientMessage(JSON.stringify({ type: "capabilities.snapshot", target: { kind: "session", id: "s1" } }))).toThrow();
  });

  it("parses capability library mutations and rejects unsafe shapes", () => {
    const binding = {
      packInstanceId: "pack-1",
      scopeKind: "repo-local",
      scopeRef: "repo-1",
      audience: { agents: ["master", "worker"], origins: ["ui"] },
      enabled: true,
    };
    const valid = [
      { type: "capabilities.library", reqId: "q1" },
      { type: "capabilities.pack.add", reqId: "q2", path: "/packs/team" },
      { type: "capabilities.pack.remove", reqId: "q3", instanceId: "pack-1" },
      { type: "capabilities.binding.set", reqId: "q4", id: "binding-1", binding },
      { type: "capabilities.binding.delete", reqId: "q5", id: "binding-1" },
      { type: "capabilities.trust.set", reqId: "q6", instanceId: "pack-1", digest: "a".repeat(64), trusted: true },
      { type: "capabilities.secret.set", reqId: "q7", instanceId: "pack-1", key: "token", value: "secret" },
      { type: "capabilities.secret.delete", reqId: "q8", instanceId: "pack-1", key: "token" },
      { type: "capabilities.refresh", reqId: "q9", instanceId: "pack-1" },
      { type: "capabilities.refresh", reqId: "q10" },
      { type: "capabilities.worker.reload", reqId: "q11", workerId: "worker-1" },
      { type: "capabilities.worker.reload", reqId: "q12", workerId: "worker-1", whenIdle: true },
    ];
    for (const message of valid) expect(() => parseClientMessage(JSON.stringify(message))).not.toThrow();

    const invalid = [
      { type: "capabilities.pack.add", reqId: "q", path: "" },
      { type: "capabilities.pack.remove", reqId: "q", instanceId: "" },
      { type: "capabilities.binding.set", reqId: "q", id: "b", binding: { ...binding, scopeKind: "future" } },
      { type: "capabilities.binding.set", reqId: "q", id: "b", binding: { ...binding, audience: { agents: [], origins: ["ui"] } } },
      { type: "capabilities.binding.set", reqId: "q", id: "b", binding: { ...binding, scopeKind: "rookery", scopeRef: "repo-1" } },
      { type: "capabilities.binding.set", reqId: "q", id: "b", binding: { ...binding, scopeKind: "worker", scopeRef: "" } },
      { type: "capabilities.trust.set", reqId: "q", instanceId: "pack-1", digest: "short", trusted: true },
      { type: "capabilities.secret.set", reqId: "q", instanceId: "pack-1", key: "token", value: "   " },
      { type: "capabilities.worker.reload", reqId: "q", workerId: "" },
      { type: "capabilities.worker.reload", reqId: "q", workerId: "worker-1", whenIdle: "yes" },
    ];
    for (const message of invalid) expect(() => parseClientMessage(JSON.stringify(message))).toThrow();
  });

  it("parses generated MCP pack creation without flattening arguments or secret references", () => {
    const parsed = clientMessageSchema.parse({
      type: "capabilities.mcpPack.create",
      reqId: "q1",
      input: {
        id: "repo-tools",
        displayName: "Repo Tools",
        version: "1.0.0",
        description: "Repository MCP servers",
        repoId: "repo-1",
        agents: ["master", "worker"],
        mcpServers: [
          {
            id: "db",
            transport: "stdio",
            command: "npx",
            args: ["-y", "db-mcp"],
            secretEnv: { TOKEN: { source: "rookery-secret", key: "db-token" } },
          },
          {
            id: "docs",
            transport: "streamable-http",
            url: "https://example.test/mcp",
            auth: { bearerToken: { source: "rookery-secret", key: "docs-token" } },
          },
        ],
        secretValues: { "db-token": "db-value", "docs-token": "docs-value" },
      },
    });

    expect(parsed.type).toBe("capabilities.mcpPack.create");
    if (parsed.type !== "capabilities.mcpPack.create") throw new Error("unexpected message type");
    expect(parsed.input.mcpServers[0]).toMatchObject({ args: ["-y", "db-mcp"] });
    expect(parsed.input.mcpServers[1]).toMatchObject({
      auth: { bearerToken: { source: "rookery-secret", key: "docs-token" } },
    });
  });

  it("rejects unsafe generated MCP pack creation inputs", () => {
    const valid = {
      type: "capabilities.mcpPack.create",
      reqId: "q1",
      input: {
        id: "repo-tools",
        displayName: "Repo Tools",
        version: "1.0.0",
        description: "Repository MCP servers",
        repoId: "repo-1",
        agents: ["master", "worker"],
        mcpServers: [
          { id: "docs", transport: "streamable-http", url: "https://example.test/mcp" },
        ],
      },
    };
    const invalid = [
      { ...valid, input: { ...valid.input, mcpServers: [] } },
      { ...valid, input: { ...valid.input, mcpServers: [valid.input.mcpServers[0], valid.input.mcpServers[0]] } },
      { ...valid, input: { ...valid.input, mcpServers: [{ ...valid.input.mcpServers[0], id: "Invalid ID" }] } },
      { ...valid, input: { ...valid.input, mcpServers: [{ id: "docs", transport: "streamable-http", url: "file:///tmp/mcp" }] } },
      { ...valid, input: { ...valid.input, mcpServers: [{ id: "docs", transport: "stdio", command: "" }] } },
      { ...valid, input: { ...valid.input, agents: ["side"] } },
      { ...valid, input: { ...valid.input, mcpServers: [{ ...valid.input.mcpServers[0], auth: { bearerToken: { source: "rookery-secret", key: "docs-token" } } }], secretValues: { "docs-token": "   " } } },
      { ...valid, input: { ...valid.input, secretValues: { undeclared: "secret" } } },
      { ...valid, input: { ...valid.input, unexpected: true } },
    ];

    for (const message of invalid) {
      expect(clientMessageSchema.safeParse(message).success).toBe(false);
    }
  });

  it("parses lightweight MCP, Skill, and quick binding requests strictly", () => {
    const mcp = {
      type: "capabilities.mcp.create",
      reqId: "mcp-1",
      input: {
        id: "docs",
        displayName: "Docs MCP",
        description: "Documentation tools",
        mcpServer: {
          id: "docs",
          transport: "streamable-http",
          url: "https://example.test/mcp",
          auth: { bearerToken: { source: "rookery-secret", key: "docs-token" } },
        },
        secretValues: { "docs-token": "secret" },
      },
    };
    const skill = {
      type: "capabilities.skill.create",
      reqId: "skill-1",
      input: {
        id: "review",
        displayName: "Review Skill",
        description: "Review changes",
        sourcePath: "/skills/review",
      },
    };
    const quick = {
      type: "capabilities.binding.quickSet",
      reqId: "quick-1",
      input: {
        packInstanceId: "pack-1",
        scopeKind: "repo-local",
        scopeRef: "repo-1",
        mode: "disabled",
        agents: ["master", "worker"],
      },
    };

    expect(clientMessageSchema.parse(mcp)).toEqual(mcp);
    expect(clientMessageSchema.parse(skill)).toEqual(skill);
    expect(clientMessageSchema.parse(quick)).toEqual(quick);
    expect(clientMessageSchema.safeParse({ ...mcp, input: { ...mcp.input, secretValues: { undeclared: "secret" } } }).success).toBe(false);
    expect(clientMessageSchema.safeParse({ ...skill, input: { ...skill.input, sourcePath: "" } }).success).toBe(false);
    expect(clientMessageSchema.safeParse({ ...skill, input: { ...skill.input, unexpected: true } }).success).toBe(false);
    expect(clientMessageSchema.safeParse({ ...quick, input: { ...quick.input, scopeKind: "session" } }).success).toBe(false);
    expect(clientMessageSchema.safeParse({ ...quick, input: { ...quick.input, scopeKind: "rookery", scopeRef: "repo-1" } }).success).toBe(false);
    expect(clientMessageSchema.safeParse({ ...quick, input: { ...quick.input, mode: "enabled", agents: [] } }).success).toBe(false);
    expect(clientMessageSchema.safeParse({ ...quick, input: { ...quick.input, mode: "inherit", agents: [] } }).success).toBe(true);
  });

  it("settings.set: accepts null (reset-to-default) and validates effort against the enum", () => {
    // null → reset to default (only reachable if the schema is nullable)
    expect(() => parseClientMessage(JSON.stringify({ type: "settings.set", reqId: "q", settings: { masterModel: null } }))).not.toThrow();
    // valid effort passes
    expect(() => parseClientMessage(JSON.stringify({ type: "settings.set", reqId: "q", settings: { masterEffort: "high" } }))).not.toThrow();
    // invalid effort is rejected (previously it passed and was then silently dropped every turn)
    expect(() => parseClientMessage(JSON.stringify({ type: "settings.set", reqId: "q", settings: { workerEffort: "HIGH" } }))).toThrow();
  });

  it("parses fleet + repos + history requests with reqId", () => {
    expect(parseClientMessage(JSON.stringify({ type: "fleet.list", reqId: "r1" }))).toMatchObject({ type: "fleet.list", reqId: "r1" });
    expect(parseClientMessage(JSON.stringify({ type: "fleet.diff", reqId: "r2", id: "a1" }))).toMatchObject({ type: "fleet.diff", id: "a1" });
    expect(parseClientMessage(JSON.stringify({ type: "fleet.stop", reqId: "r3", id: "a1" }))).toMatchObject({ type: "fleet.stop" });
    expect(parseClientMessage(JSON.stringify({ type: "fleet.subscribe" }))).toMatchObject({ type: "fleet.subscribe" });
    expect(parseClientMessage(JSON.stringify({ type: "repos.register", reqId: "r4", name: "p", path: "/p", description: "d" }))).toMatchObject({ type: "repos.register", name: "p" });
    expect(parseClientMessage(JSON.stringify({ type: "session.history", reqId: "r5", sessionId: "s1" }))).toMatchObject({ type: "session.history", sessionId: "s1" });
    expect(parseClientMessage(JSON.stringify({ type: "workflow.list", reqId: "r6", workerId: "w1" }))).toMatchObject({ type: "workflow.list", workerId: "w1" });
    expect(parseClientMessage(JSON.stringify({ type: "workflow.agent.history", reqId: "r7", workerId: "w1", taskId: "task-1", agentId: "a1" }))).toMatchObject({ type: "workflow.agent.history", taskId: "task-1", agentId: "a1" });
    expect(() => parseClientMessage(JSON.stringify({ type: "workflow.agent.history", reqId: "r8", workerId: "w1", taskId: "task-1" }))).toThrow();
  });
  it("parses worker.interrupt (id required, reqId optional)", () => {
    expect(parseClientMessage(JSON.stringify({ type: "worker.interrupt", id: "a1" }))).toMatchObject({ type: "worker.interrupt", id: "a1" });
    expect(parseClientMessage(JSON.stringify({ type: "worker.interrupt", id: "a1", reqId: "q1" }))).toMatchObject({ type: "worker.interrupt", id: "a1", reqId: "q1" });
    expect(() => parseClientMessage(JSON.stringify({ type: "worker.interrupt" }))).toThrow(); // id missing → rejected
  });
  it("fleet.spawn parses without a task (task-less spawn)", () => {
    expect(clientMessageSchema.safeParse({ type: "fleet.spawn", reqId: "r", repo: "app" }).success).toBe(true);
    expect(clientMessageSchema.safeParse({ type: "fleet.spawn", reqId: "r", repo: "app", task: "do x" }).success).toBe(true);
  });

  it("fleet.spawn: costBudgetUsd accepts a positive number, null, or omitted; rejects non-positive", () => {
    expect(clientMessageSchema.safeParse({ type: "fleet.spawn", reqId: "r", repo: "app", costBudgetUsd: 5.5 }).success).toBe(true);
    expect(clientMessageSchema.safeParse({ type: "fleet.spawn", reqId: "r", repo: "app", costBudgetUsd: null }).success).toBe(true);
    expect(clientMessageSchema.safeParse({ type: "fleet.spawn", reqId: "r", repo: "app" }).success).toBe(true); // omitted
    expect(clientMessageSchema.safeParse({ type: "fleet.spawn", reqId: "r", repo: "app", costBudgetUsd: 0 }).success).toBe(false);
    expect(clientMessageSchema.safeParse({ type: "fleet.spawn", reqId: "r", repo: "app", costBudgetUsd: -1 }).success).toBe(false);
  });

  it("rejects unknown type", () => {
    expect(() => parseClientMessage(JSON.stringify({ type: "nope" }))).toThrow();
  });
});

describe("automation protocol messages", () => {
  it("automation.create: valid cron/master create parses", () => {
    const ok = {
      type: "automation.create", reqId: "q",
      automation: {
        name: "n",
        trigger: { kind: "cron", cron: "0 3 * * *", timezone: "UTC" },
        action: { kind: "master", prompt: "p", cwd: "/w", sessionMode: "reuse" },
      },
    };
    expect(() => parseClientMessage(JSON.stringify(ok))).not.toThrow();
  });

  it("automation.create: invalid cron expression is rejected", () => {
    const invalid = {
      type: "automation.create", reqId: "q",
      automation: {
        name: "n",
        trigger: { kind: "cron", cron: "99 99 * * *", timezone: "UTC" },
        action: { kind: "master", prompt: "p", cwd: "/w", sessionMode: "reuse" },
      },
    };
    expect(() => parseClientMessage(JSON.stringify(invalid))).toThrow();
  });

  it("automation.create: interval trigger parses; everyMinutes must be a positive integer", () => {
    const mk = (everyMinutes: unknown) => ({
      type: "automation.create", reqId: "q",
      automation: {
        name: "poll",
        trigger: { kind: "interval", everyMinutes },
        action: { kind: "master", prompt: "p", cwd: "/w", sessionMode: "reuse" },
      },
    });
    expect(() => parseClientMessage(JSON.stringify(mk(15)))).not.toThrow();
    expect(() => parseClientMessage(JSON.stringify(mk(0)))).toThrow(); // zero rejected
    expect(() => parseClientMessage(JSON.stringify(mk(-5)))).toThrow(); // negative rejected
    expect(() => parseClientMessage(JSON.stringify(mk(1.5)))).toThrow(); // non-integer rejected
  });

  it("automation.create: worker-settled trigger parses; bad bucket rejected; run vars accept worker keys", () => {
    const wmk = (trigger: unknown) => ({
      type: "automation.create", reqId: "q",
      automation: { name: "n", trigger, action: { kind: "master", prompt: "p", cwd: "/w", sessionMode: "reuse" } },
    });
    expect(() => parseClientMessage(JSON.stringify(wmk({ kind: "worker" })))).not.toThrow(); // all fields optional
    expect(() => parseClientMessage(JSON.stringify(wmk({ kind: "worker", repo: "app", on: ["stopped", "failure"], label: "impl" })))).not.toThrow();
    expect(() => parseClientMessage(JSON.stringify(wmk({ kind: "worker", on: ["running"] })))).toThrow(); // not a settle bucket
    expect(clientMessageSchema.safeParse({ type: "automation.run", reqId: "r", id: "a1", vars: { workerId: "w1", branch: "b", tail: "t" } }).success).toBe(true);
  });

  it("automation.create: slack/worker create parses", () => {
    const ok = {
      type: "automation.create", reqId: "q",
      automation: {
        name: "slack-worker",
        trigger: { kind: "slack", channels: ["#general"], keyword: "deploy" },
        action: { kind: "worker", repo: "app", task: "run tests" },
      },
    };
    expect(() => parseClientMessage(JSON.stringify(ok))).not.toThrow();
  });

  it("automation.run / set_enabled parse", () => {
    expect(() => parseClientMessage(JSON.stringify({ type: "automation.run", reqId: "q", id: "s1" }))).not.toThrow();
    expect(() => parseClientMessage(JSON.stringify({ type: "automation.set_enabled", reqId: "q", id: "s1", enabled: true }))).not.toThrow();
  });

  it("automation.run accepts optional vars (and still parses without them)", () => {
    expect(clientMessageSchema.safeParse({ type: "automation.run", reqId: "r", id: "a1" }).success).toBe(true);
    const withVars = clientMessageSchema.safeParse({ type: "automation.run", reqId: "r", id: "a1", vars: { message: "hi", channel: "C1" } });
    expect(withVars.success).toBe(true);
    if (withVars.success && withVars.data.type === "automation.run") expect(withVars.data.vars?.message).toBe("hi");
  });

  it("old schedule.* types are rejected", () => {
    expect(() => parseClientMessage(JSON.stringify({ type: "schedule.list", reqId: "q" }))).toThrow();
    expect(() => parseClientMessage(JSON.stringify({ type: "schedule.create", reqId: "q", job: {} }))).toThrow();
  });

  it("automation.create: permissionMode + maxTurns are accepted, validated, and optional", () => {
    const base = {
      type: "automation.create", reqId: "q",
      automation: {
        name: "n",
        trigger: { kind: "cron", cron: "0 3 * * *", timezone: "UTC" },
        action: { kind: "master", prompt: "p", cwd: "/w", sessionMode: "reuse" },
      },
    };
    // valid permissionMode + maxTurns
    expect(() => parseClientMessage(JSON.stringify({ ...base, automation: { ...base.automation, permissionMode: "plan", maxTurns: 5 } }))).not.toThrow();
    // both omitted (optional)
    expect(() => parseClientMessage(JSON.stringify(base))).not.toThrow();
    // null is allowed (explicit clear)
    expect(() => parseClientMessage(JSON.stringify({ ...base, automation: { ...base.automation, permissionMode: null, maxTurns: null } }))).not.toThrow();
    // invalid permissionMode string
    expect(() => parseClientMessage(JSON.stringify({ ...base, automation: { ...base.automation, permissionMode: "lol" } }))).toThrow();
    // maxTurns=0 rejected (must be positive)
    expect(() => parseClientMessage(JSON.stringify({ ...base, automation: { ...base.automation, maxTurns: 0 } }))).toThrow();
    // maxTurns=-1 rejected
    expect(() => parseClientMessage(JSON.stringify({ ...base, automation: { ...base.automation, maxTurns: -1 } }))).toThrow();
  });

  it("automation.create: costBudgetUsd is accepted, validated, and optional (mirrors maxTurns)", () => {
    const base = {
      type: "automation.create", reqId: "q",
      automation: {
        name: "n",
        trigger: { kind: "cron", cron: "0 3 * * *", timezone: "UTC" },
        action: { kind: "master", prompt: "p", cwd: "/w", sessionMode: "reuse" },
      },
    };
    // valid positive number
    expect(() => parseClientMessage(JSON.stringify({ ...base, automation: { ...base.automation, costBudgetUsd: 12.5 } }))).not.toThrow();
    // omitted (optional)
    expect(() => parseClientMessage(JSON.stringify(base))).not.toThrow();
    // null allowed (explicit clear)
    expect(() => parseClientMessage(JSON.stringify({ ...base, automation: { ...base.automation, costBudgetUsd: null } }))).not.toThrow();
    // 0 rejected (must be positive)
    expect(() => parseClientMessage(JSON.stringify({ ...base, automation: { ...base.automation, costBudgetUsd: 0 } }))).toThrow();
    // negative rejected
    expect(() => parseClientMessage(JSON.stringify({ ...base, automation: { ...base.automation, costBudgetUsd: -5 } }))).toThrow();
  });

  it("automation.create: provider accepts claude|codex, is optional, and rejects a bad enum value", () => {
    const base = {
      type: "automation.create", reqId: "q",
      automation: {
        name: "n",
        trigger: { kind: "cron", cron: "0 3 * * *", timezone: "UTC" },
        action: { kind: "master", prompt: "p", cwd: "/w", sessionMode: "reuse" },
      },
    };
    // omitted → undefined (allowed)
    const omitted = clientMessageSchema.safeParse(base);
    expect(omitted.success).toBe(true);
    if (omitted.success && omitted.data.type === "automation.create") expect(omitted.data.automation.provider).toBeUndefined();
    // "codex" accepted
    const codex = clientMessageSchema.safeParse({ ...base, automation: { ...base.automation, provider: "codex" } });
    expect(codex.success).toBe(true);
    if (codex.success && codex.data.type === "automation.create") expect(codex.data.automation.provider).toBe("codex");
    // "claude" accepted
    expect(clientMessageSchema.safeParse({ ...base, automation: { ...base.automation, provider: "claude" } }).success).toBe(true);
    // bad enum value rejected
    expect(() => parseClientMessage(JSON.stringify({ ...base, automation: { ...base.automation, provider: "gpt" } }))).toThrow();
  });
});

describe("protocol", () => {
  it("parses Side conversation lifecycle requests for master and worker sources", () => {
    expect(parseClientMessage(JSON.stringify({ type: "side.start", sourceKind: "master", sourceId: "s1", text: "why?", model: "claude-opus-4-8", effort: "high", reqId: "q1" }))).toEqual({
      type: "side.start", sourceKind: "master", sourceId: "s1", text: "why?", model: "claude-opus-4-8", effort: "high", reqId: "q1",
    });
    expect(parseClientMessage(JSON.stringify({ type: "side.start", sourceKind: "worker", sourceId: "w1", text: "what changed?", reqId: "q-worker" }))).toMatchObject({
      type: "side.start", sourceKind: "worker", sourceId: "w1",
    });
    expect(parseClientMessage(JSON.stringify({ type: "side.send", sideId: "btw1", text: "follow up", reqId: "q2" }))).toMatchObject({ type: "side.send", sideId: "btw1" });
    expect(parseClientMessage(JSON.stringify({ type: "side.stop", sideId: "btw1" }))).toEqual({ type: "side.stop", sideId: "btw1" });
    expect(parseClientMessage(JSON.stringify({ type: "side.close", sideId: "btw1", reqId: "q3" }))).toMatchObject({ type: "side.close", sideId: "btw1" });
    expect(() => parseClientMessage(JSON.stringify({ type: "side.start", sourceKind: "master", sourceId: "s1" }))).toThrow();
    expect(() => parseClientMessage(JSON.stringify({ type: "side.start", sourceKind: "other", sourceId: "s1", text: "x" }))).toThrow();
  });

  it("parses a valid session.send", () => {
    const msg = parseClientMessage(JSON.stringify({ type: "session.send", sessionId: "s1", text: "hi" }));
    expect(msg).toEqual({ type: "session.send", sessionId: "s1", text: "hi" });
  });

  it("session.send accepts optional clientMsgId", () => {
    const ok = parseClientMessage(JSON.stringify({ type: "session.send", sessionId: "s1", text: "hi", clientMsgId: "c1" }));
    expect(ok.type).toBe("session.send");
    const ok2 = parseClientMessage(JSON.stringify({ type: "session.send", sessionId: "s1", text: "hi" })); // passes even when absent
    expect(ok2.type).toBe("session.send");
  });

  it("parses session.create with optional cwd", () => {
    expect(parseClientMessage(JSON.stringify({ type: "session.create" }))).toEqual({
      type: "session.create",
    });
  });

  it("parses session.create with an optional provider (claude|codex); rejects anything else", () => {
    expect(parseClientMessage(JSON.stringify({ type: "session.create", provider: "codex" }))).toEqual({
      type: "session.create",
      provider: "codex",
    });
    expect(() => parseClientMessage(JSON.stringify({ type: "session.create", provider: "gpt" }))).toThrow();
  });

  it("parses session.open with an external key", () => {
    expect(parseClientMessage(JSON.stringify({ type: "session.open", key: "thread-42" }))).toEqual({
      type: "session.open",
      key: "thread-42",
    });
  });

  it("throws when session.open is missing key", () => {
    expect(() => parseClientMessage(JSON.stringify({ type: "session.open" }))).toThrow();
  });

  it("throws on invalid JSON", () => {
    expect(() => parseClientMessage("{not json")).toThrow();
  });

  it("throws on unknown type", () => {
    expect(() => parseClientMessage(JSON.stringify({ type: "nope" }))).toThrow();
  });

  it("throws when required field missing", () => {
    expect(() => parseClientMessage(JSON.stringify({ type: "session.send", sessionId: "s1" }))).toThrow();
  });

  it("serializes server messages round-trip", () => {
    const msg: ServerMessage = {
      type: "event",
      event: { type: "master.message", sessionId: "s1", role: "assistant", content: "hello" },
    };
    expect(JSON.parse(serializeServerMessage(msg))).toEqual(msg);
  });

  it("parses codex.models.list (reqId required)", () => {
    expect(parseClientMessage(JSON.stringify({ type: "codex.models.list", reqId: "cm1" }))).toEqual({
      type: "codex.models.list",
      reqId: "cm1",
    });
    expect(() => parseClientMessage(JSON.stringify({ type: "codex.models.list" }))).toThrow(); // reqId missing → rejected
  });

  it("codex.models.result accepts a CodexModelInfo[] and null (couldn't fetch → desktop free-text fallback)", () => {
    const withModels: ServerMessage = {
      type: "codex.models.result",
      reqId: "cm2",
      models: [{ id: "gpt-5.5", displayName: "GPT-5.5", defaultEffort: "xhigh", supportedEfforts: ["low", "medium", "high", "xhigh"], isDefault: true }],
    };
    expect(JSON.parse(serializeServerMessage(withModels))).toEqual(withModels);

    const nullModels: ServerMessage = { type: "codex.models.result", reqId: "cm3", models: null };
    expect(JSON.parse(serializeServerMessage(nullModels))).toEqual(nullModels);
  });
});
