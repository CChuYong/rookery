import { describe, expect, it } from "vitest";
import {
  makeCodexCapabilitiesProvider,
  mapAppsResponse,
  mapConfigResponse,
  mapHooksResponse,
  mapMcpResponse,
  mapPluginResponse,
  mapSkillsResponse,
} from "../../src/core/codex-capabilities-provider.js";
import { fakeCodexSpawn } from "../helpers/fake-codex.js";
import { CODEX_MANAGED_SECRET_SAFETY_ARGS, type CodexSpawn, type CodexTransport } from "../../src/core/codex/codex-transport.js";

const skillResponse = {
  data: [{
    cwd: "/repo",
    skills: [
      { name: "release", description: "Ship", path: "/repo/.agents/skills/release/SKILL.md", scope: "repo", enabled: true },
      { name: "legacy", description: "Old flow", path: "/home/.agents/skills/legacy/SKILL.md", scope: "user", enabled: false },
      { description: "missing name", path: "/bad", scope: "repo", enabled: true },
    ],
    errors: [{ path: "/repo/.agents/skills/broken/SKILL.md", message: "invalid frontmatter" }],
  }],
};

describe("Codex capability response mappers", () => {
  it("maps skills with scope, state, path, and load diagnostics", () => {
    const result = mapSkillsResponse(skillResponse);

    expect(result.entries[0]).toMatchObject({
      id: "codex.skill.legacy./home/.agents/skills/legacy/SKILL.md",
      kind: "skill",
      scope: "user",
      state: "unavailable",
      evidence: "runtime",
    });
    expect(result.entries[0]?.invocation).toBeUndefined();
    expect(result.entries[1]).toMatchObject({
      id: "codex.skill.release./repo/.agents/skills/release/SKILL.md",
      name: "release",
      detail: "/repo/.agents/skills/release/SKILL.md",
      scope: "repo",
      state: "applied",
      invocation: { type: "prompt", name: "$release" },
    });
    expect(result.diagnostics).toEqual([{
      id: "codex.skills.load./repo/.agents/skills/broken/SKILL.md",
      source: "Codex skills/list",
      severity: "warning",
      message: "/repo/.agents/skills/broken/SKILL.md: invalid frontmatter",
    }]);
  });

  it("maps hooks and distinguishes disabled and untrusted hooks", () => {
    const result = mapHooksResponse({ data: [{
      cwd: "/repo",
      hooks: [
        { key: "fmt", eventName: "postToolUse", handlerType: "command", matcher: "Edit", command: "npm fmt", sourcePath: "/repo/.codex/hooks.json", source: "project", enabled: true, trustStatus: "trusted" },
        { key: "guard", eventName: "preToolUse", handlerType: "command", sourcePath: "/repo/.codex/hooks.json", source: "project", enabled: true, trustStatus: "untrusted" },
        { key: "off", eventName: "stop", handlerType: "prompt", sourcePath: "/home/hooks.json", source: "user", enabled: false, trustStatus: "trusted" },
      ],
      warnings: ["legacy hook syntax"],
      errors: [{ path: "/repo/bad-hook.json", message: "bad matcher" }],
    }] });

    expect(result.entries.map((entry) => [entry.id, entry.state, entry.scope])).toEqual([
      ["codex.hook.fmt./repo/.codex/hooks.json", "applied", "repo"],
      ["codex.hook.guard./repo/.codex/hooks.json", "blocked", "repo"],
      ["codex.hook.off./home/hooks.json", "unavailable", "user"],
    ]);
    expect(result.entries[0]?.detail).toContain("npm fmt");
    expect(result.diagnostics).toHaveLength(2);
  });

  it("maps MCP auth and tool inventory", () => {
    const result = mapMcpResponse({ data: [
      { name: "github", tools: { search: {}, issue: {} }, authStatus: "oAuth" },
      { name: "notion", tools: {}, authStatus: "notLoggedIn" },
    ], nextCursor: null });

    expect(result.entries.map((entry) => [entry.name, entry.state, entry.detail])).toEqual([
      ["github", "applied", "OAuth · 2 tools"],
      ["notion", "unavailable", "Not logged in · 0 tools"],
    ]);
  });

  it("maps only installed plugins and preserves admin-disabled state", () => {
    const result = mapPluginResponse({
      marketplaces: [{
        name: "local",
        path: "/repo/.codex/plugins.json",
        plugins: [
          { id: "reviewer", name: "reviewer", installed: true, enabled: true, availability: "AVAILABLE", localVersion: "1.2.0", interface: { displayName: "Reviewer", shortDescription: "Checks diffs" } },
          { id: "guard", name: "guard", installed: true, enabled: true, availability: "DISABLED_BY_ADMIN" },
          { id: "catalog-only", name: "catalog-only", installed: false, enabled: false },
        ],
      }],
      marketplaceLoadErrors: [{ marketplacePath: "/bad", message: "cannot read" }],
    });

    expect(result.entries.map((entry) => [entry.id, entry.name, entry.state])).toEqual([
      ["codex.plugin.guard", "guard", "blocked"],
      ["codex.plugin.reviewer", "Reviewer", "applied"],
    ]);
    expect(result.diagnostics).toHaveLength(1);
  });

  it("maps apps and config layers without exposing raw config values", () => {
    const apps = mapAppsResponse({ data: [
      { id: "drive", name: "Google Drive", description: "Files", isAccessible: true, isEnabled: true, pluginDisplayNames: ["Workspace"] },
      { id: "crm", name: "CRM", isAccessible: false, isEnabled: true },
      { id: "disabled", name: "Disabled app", isAccessible: false, isEnabled: false },
    ], nextCursor: null });
    expect(apps.entries.map((entry) => [entry.id, entry.state])).toEqual([
      ["codex.app.disabled", "unavailable"],
      ["codex.app.drive", "applied"],
    ]);

    const config = mapConfigResponse({ layers: [
      { name: { type: "user", file: "/home/.codex/config.toml" }, version: "1", config: { api_key: "secret" } },
      { name: { type: "project", dotCodexFolder: "/repo/.codex" }, version: "2", config: {}, disabledReason: "untrusted workspace" },
    ] });
    expect(config.entries).toEqual([
      expect.objectContaining({ id: "codex.instruction.project./repo/.codex", scope: "repo", state: "unavailable", detail: "/repo/.codex · untrusted workspace" }),
      expect.objectContaining({ id: "codex.instruction.user./home/.codex/config.toml", scope: "user", state: "applied", detail: "/home/.codex/config.toml" }),
    ]);
    expect(JSON.stringify(config)).not.toContain("secret");
  });

  it("reports malformed structured responses instead of treating them as successful empties", () => {
    expect(mapSkillsResponse({}).diagnostics[0]).toMatchObject({ id: "codex.skills.malformed" });
    expect(mapHooksResponse(null).diagnostics[0]).toMatchObject({ id: "codex.hooks.malformed" });
    expect(mapMcpResponse({}).diagnostics[0]).toMatchObject({ id: "codex.mcp.malformed" });
    expect(mapPluginResponse({}).diagnostics[0]).toMatchObject({ id: "codex.plugins.malformed" });
    expect(mapAppsResponse({}).diagnostics[0]).toMatchObject({ id: "codex.apps.malformed" });
    expect(mapConfigResponse({}).diagnostics[0]).toMatchObject({ id: "codex.config.malformed" });
  });
});

describe("makeCodexCapabilitiesProvider", () => {
  const allRpc = () => ({
    "skills/list": () => ({ result: skillResponse }),
    "hooks/list": () => ({ result: { data: [] } }),
    "mcpServerStatus/list": (_params: Record<string, unknown>, call: number) => call === 0
      ? { result: { data: [{ name: "one", tools: {}, authStatus: "unsupported" }], nextCursor: "page-2" } }
      : { result: { data: [{ name: "two", tools: {}, authStatus: "bearerToken" }], nextCursor: null } },
    "plugin/list": () => ({ result: { marketplaces: [], marketplaceLoadErrors: [] } }),
    "app/list": () => ({ result: { data: [], nextCursor: null } }),
    "config/read": () => ({ result: { layers: [] } }),
  });

  it("uses one initialized child, target cwd, configured env, and bounded MCP pagination", async () => {
    const fake = fakeCodexSpawn(() => [], { rpc: allRpc() });
    const provider = makeCodexCapabilitiesProvider({ spawn: fake.spawn, env: () => ({ BASE: "yes" }) });
    const result = await provider.list({ cwd: "/repo", env: { CODEX_HOME: "/target-home", ROOKERY_CAP_SECRET_INVENTORY: "inventory-secret" } });

    expect(result.entries.map((entry) => entry.id)).toEqual(expect.arrayContaining([
      "codex.skill.release./repo/.agents/skills/release/SKILL.md",
      "codex.mcp.one",
      "codex.mcp.two",
    ]));
    expect(fake.spawns).toHaveLength(1);
    expect(fake.spawns[0]?.env).toMatchObject({ BASE: "yes", CODEX_HOME: "/target-home", ROOKERY_CAP_SECRET_INVENTORY: "inventory-secret" });
    expect(fake.spawns[0]?.args).toEqual(CODEX_MANAGED_SECRET_SAFETY_ARGS);
    expect(JSON.stringify(fake.spawns[0]?.args)).not.toContain("inventory-secret");
    expect(fake.killed[0]).toBe(true);
    expect(fake.requests.find((request) => request.method === "skills/list")?.params).toEqual({ cwds: ["/repo"], forceReload: false });
    expect(fake.requests.find((request) => request.method === "hooks/list")?.params).toEqual({ cwds: ["/repo"] });
    expect(fake.requests.find((request) => request.method === "plugin/list")?.params).toEqual({ cwds: ["/repo"], marketplaceKinds: ["local"] });
    expect(fake.requests.find((request) => request.method === "config/read")?.params).toEqual({ cwd: "/repo", includeLayers: true });
    expect(fake.requests.find((request) => request.method === "app/list")?.params).toEqual({ limit: 10_000, forceRefetch: false });
    expect(fake.requests.filter((request) => request.method === "mcpServerStatus/list").map((request) => request.params.cursor)).toEqual([undefined, "page-2"]);
  });

  it("keeps successful inventory when one structured method is unsupported", async () => {
    const rpc = allRpc();
    rpc["hooks/list"] = () => ({ error: { code: -32601, message: "method not found" } });
    const fake = fakeCodexSpawn(() => [], { rpc });

    const result = await makeCodexCapabilitiesProvider({ spawn: fake.spawn }).list({ cwd: "/repo" });

    expect(result.entries.some((entry) => entry.kind === "skill")).toBe(true);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "codex.hooks.probe", source: "Codex hooks/list", message: expect.stringContaining("method not found") }),
    ]));
  });

  it("provisions the configured API key before inventory", async () => {
    const fake = fakeCodexSpawn(() => [], { rpc: allRpc(), requiresOpenaiAuth: true });
    await makeCodexCapabilitiesProvider({ spawn: fake.spawn, apiKey: () => "sk-test" }).list({ cwd: "/repo" });

    const methods = fake.requests.map((request) => request.method);
    expect(methods.indexOf("account/login/start")).toBeGreaterThan(methods.indexOf("initialize"));
    expect(methods.indexOf("account/login/start")).toBeLessThan(methods.indexOf("skills/list"));
  });

  it("returns an explicit diagnostic and closes the child when initialization fails", async () => {
    const spawn: CodexSpawn = () => {
      let exit: (info: { code: number | null; message?: string }) => void = () => {};
      queueMicrotask(() => exit({ code: 1, message: "spawn failed" }));
      return { write: () => {}, onLine: () => {}, onExit: (cb) => { exit = cb; }, kill: () => {} } satisfies CodexTransport;
    };

    const result = await makeCodexCapabilitiesProvider({ spawn, timeoutMs: 25 }).list({ cwd: "/repo" });

    expect(result.entries).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ id: "codex.app-server", severity: "error", message: expect.stringContaining("spawn failed") }),
    ]);
  });

  it("bounds a hung probe, keeps other results, and closes the child", async () => {
    const rpc = allRpc();
    rpc["app/list"] = () => ({ silent: true });
    const fake = fakeCodexSpawn(() => [], { rpc });

    const result = await makeCodexCapabilitiesProvider({ spawn: fake.spawn, timeoutMs: 20 }).list({ cwd: "/repo" });

    expect(result.entries.some((entry) => entry.kind === "skill")).toBe(true);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "codex.apps.probe", message: expect.stringContaining("timed out") }),
    ]));
    expect(fake.killed[0]).toBe(true);
  });
});
