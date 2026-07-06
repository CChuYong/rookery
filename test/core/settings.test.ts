import { describe, it, expect } from "vitest";
import { openDb } from "../../src/persistence/db.js";
import { Repositories } from "../../src/persistence/repositories.js";
import { Settings, applyApiKeyToEnv } from "../../src/core/settings.js";
import { loadConfig } from "../../src/config.js";

const config = loadConfig({}); // defaults without env

describe("Settings", () => {
  it("returns config defaults when DB is empty (incl. effort)", () => {
    const s = new Settings(new Repositories(openDb(":memory:")), config);
    expect(s.all()).toEqual({
      masterName: "rookery", // settings-only default (no config fallback)
      masterModel: config.masterModel,
      workerModel: config.workerModel,
      masterEffort: config.masterEffort,
      workerEffort: config.workerEffort,
      codexWorkerModel: "gpt-5.5",
      codexMasterModel: "gpt-5.5",
      codexBin: "codex",
      codexTurnIdleTimeoutMs: "120000",
      codexHandshakeTimeoutMs: "30000",
      slackCwd: process.cwd(),
      slackAllowedUsers: "",
      slackAllowAll: "0",
      slackRefuseReply: "1",
      slackRefusalMessage: "Sorry, you're not authorized to use this bot.",
      usageRefreshMs: "120000",
      hasAcceptedDataNotice: "0",
      onboardingDone: "0",
      defaultSessionCwd: "",
      workerSlackRelayEnabled: "0",
      workerSlackRelayChannel: "",
      slackLocale: "ko",
      slackProvider: "claude",
    });
  });

  it("codexWorkerModel/codexBin: settings-only defaults, overridable, clear to default", () => {
    const s = new Settings(new Repositories(openDb(":memory:")), config);
    expect(s.codexWorkerModel()).toBe("gpt-5.5");
    expect(s.codexBin()).toBe("codex");
    s.apply({ codexWorkerModel: "gpt-5.5-mini", codexBin: "/usr/local/bin/codex" });
    expect(s.codexWorkerModel()).toBe("gpt-5.5-mini");
    expect(s.codexBin()).toBe("/usr/local/bin/codex");
    s.apply({ codexWorkerModel: null, codexBin: null });
    expect(s.codexWorkerModel()).toBe("gpt-5.5");
    expect(s.codexBin()).toBe("codex");
  });

  it("codexMasterModel: settings-only default, overridable, clears to default", () => {
    const s = new Settings(new Repositories(openDb(":memory:")), config);
    expect(s.codexMasterModel()).toBe("gpt-5.5");
    s.apply({ codexMasterModel: "gpt-5.5-mini" });
    expect(s.codexMasterModel()).toBe("gpt-5.5-mini");
    expect(s.all().codexMasterModel).toBe("gpt-5.5-mini");
    s.apply({ codexMasterModel: null });
    expect(s.codexMasterModel()).toBe("gpt-5.5");
  });

  it("codexTurnIdleTimeoutMs: settings-only default (parsed number), overridable, 0 is a valid override (not coerced), clears to default", () => {
    const s = new Settings(new Repositories(openDb(":memory:")), config);
    expect(s.codexTurnIdleTimeoutMs()).toBe(120000);
    expect(s.all().codexTurnIdleTimeoutMs).toBe("120000");
    s.apply({ codexTurnIdleTimeoutMs: "30000" });
    expect(s.codexTurnIdleTimeoutMs()).toBe(30000);
    s.apply({ codexTurnIdleTimeoutMs: "0" }); // deliberate disable — must NOT fall back to the default
    expect(s.codexTurnIdleTimeoutMs()).toBe(0);
    s.apply({ codexTurnIdleTimeoutMs: "not-a-number" }); // malformed → fail safe to the default, never NaN
    expect(s.codexTurnIdleTimeoutMs()).toBe(120000);
    s.apply({ codexTurnIdleTimeoutMs: null });
    expect(s.codexTurnIdleTimeoutMs()).toBe(120000);
  });

  it("codexHandshakeTimeoutMs: settings-only default (parsed number), overridable, 0 is a valid override (not coerced), clears to default", () => {
    const s = new Settings(new Repositories(openDb(":memory:")), config);
    expect(s.codexHandshakeTimeoutMs()).toBe(30000);
    expect(s.all().codexHandshakeTimeoutMs).toBe("30000");
    s.apply({ codexHandshakeTimeoutMs: "5000" });
    expect(s.codexHandshakeTimeoutMs()).toBe(5000);
    s.apply({ codexHandshakeTimeoutMs: "0" }); // deliberate disable — must NOT fall back to the default
    expect(s.codexHandshakeTimeoutMs()).toBe(0);
    s.apply({ codexHandshakeTimeoutMs: "not-a-number" }); // malformed → fail safe to the default, never NaN
    expect(s.codexHandshakeTimeoutMs()).toBe(30000);
    s.apply({ codexHandshakeTimeoutMs: null });
    expect(s.codexHandshakeTimeoutMs()).toBe(30000);
  });

  it("slackLocale: defaults to ko, overridable, clears to default", () => {
    const s = new Settings(new Repositories(openDb(":memory:")), config);
    expect(s.slackLocale()).toBe("ko");
    expect(s.all().slackLocale).toBe("ko");
    s.apply({ slackLocale: "en" });
    expect(s.slackLocale()).toBe("en");
    s.apply({ slackLocale: "xx" }); // non-ko, non-empty → en
    expect(s.slackLocale()).toBe("en");
    s.apply({ slackLocale: null as unknown as string }); // clear → ko
    expect(s.slackLocale()).toBe("ko");
  });

  it("slackProvider: defaults claude, overridable to codex, unknown/clear coerces back to claude", () => {
    const s = new Settings(new Repositories(openDb(":memory:")), config);
    expect(s.slackProvider()).toBe("claude");
    expect(s.all().slackProvider).toBe("claude");
    s.apply({ slackProvider: "codex" });
    expect(s.slackProvider()).toBe("codex");
    expect(s.all().slackProvider).toBe("codex");
    s.apply({ slackProvider: "bogus" }); // unknown value → coerced back to claude (opt-in only via exact "codex")
    expect(s.slackProvider()).toBe("claude");
    s.apply({ slackProvider: "codex" });
    s.apply({ slackProvider: null as unknown as string }); // clear reverts to default
    expect(s.slackProvider()).toBe("claude");
  });

  it("slack refusal: default on with default message, overridable", () => {
    const s = new Settings(new Repositories(openDb(":memory:")), config);
    expect(s.slackRefuseReply()).toBe("1"); // auto-reply on by default
    expect(s.slackRefusalMessage()).toBe("Sorry, you're not authorized to use this bot.");
    s.apply({ slackRefuseReply: "0", slackRefusalMessage: "Not allowed." });
    expect(s.slackRefuseReply()).toBe("0");
    expect(s.slackRefusalMessage()).toBe("Not allowed.");
    s.apply({ slackRefusalMessage: null as unknown as string }); // clearing reverts to default message
    expect(s.slackRefusalMessage()).toBe("Sorry, you're not authorized to use this bot.");
  });

  it("slack/usage settings: defaults, overrides, and clears", () => {
    const s = new Settings(new Repositories(openDb(":memory:")), config);
    expect(s.slackCwd()).toBe(process.cwd());
    expect(s.slackAllowedUsers()).toBe("");
    expect(s.slackAllowAll()).toBe("0");
    expect(s.usageRefreshMs()).toBe("120000");

    const out = s.apply({ slackCwd: "/work", slackAllowedUsers: "U1,U2", slackAllowAll: "1", usageRefreshMs: "30000" });
    expect(out.slackCwd).toBe("/work");
    expect(out.slackAllowedUsers).toBe("U1,U2");
    expect(out.slackAllowAll).toBe("1");
    expect(out.usageRefreshMs).toBe("30000");

    s.apply({ slackCwd: null as unknown as string }); // clearing reverts to default (cwd)
    expect(s.slackCwd()).toBe(process.cwd());
  });

  it("slack tokens: write-only secrets, DB over env fallback, configured gate", () => {
    const withEnv = new Settings(new Repositories(openDb(":memory:")), loadConfig({ SLACK_BOT_TOKEN: "env-bot", SLACK_APP_TOKEN: "env-app" }));
    expect(withEnv.slackBotToken()).toBe("env-bot");
    expect(withEnv.slackConfigured()).toBe(true);

    const s = new Settings(new Repositories(openDb(":memory:")), config);
    expect(s.slackConfigured()).toBe(false); // neither env nor DB has it
    s.setSlackBotToken("db-bot");
    expect(s.slackConfigured()).toBe(false); // app token not set yet
    s.setSlackAppToken("db-app");
    expect(s.slackConfigured()).toBe(true);
    expect(s.slackBotToken()).toBe("db-bot");
    expect(s.all()).not.toHaveProperty("slackBotToken"); // secrets are not echoed

    s.setSlackBotToken(undefined); // clear
    expect(s.slackBotToken()).toBeUndefined();
  });

  it("masterName: default rookery, persists override, trims + caps, clears to default", () => {
    const s = new Settings(new Repositories(openDb(":memory:")), config);
    expect(s.masterName()).toBe("rookery");

    expect(s.apply({ masterName: "Jarvis" }).masterName).toBe("Jarvis");
    expect(s.masterName()).toBe("Jarvis");

    s.apply({ masterName: "  Friday  " }); // trimmed on read
    expect(s.masterName()).toBe("Friday");

    s.apply({ masterName: "x".repeat(100) }); // capped at 64 chars
    expect(s.masterName()).toHaveLength(64);

    s.apply({ masterName: "   " }); // whitespace-only -> falls back to default
    expect(s.masterName()).toBe("rookery");

    s.apply({ masterName: "Atlas" });
    s.apply({ masterName: null as unknown as string }); // null -> key deleted -> reverts to default
    expect(s.masterName()).toBe("rookery");
  });

  it("persists effort overrides (global defaults used by Slack and the default entry point)", () => {
    const s = new Settings(new Repositories(openDb(":memory:")), config);
    const out = s.apply({ masterEffort: "xhigh", workerEffort: "medium" });
    expect(out.masterEffort).toBe("xhigh");
    expect(out.workerEffort).toBe("medium");
  });

  it("apply persists overrides; null reverts to default", () => {
    const s = new Settings(new Repositories(openDb(":memory:")), config);
    const out = s.apply({ masterModel: "claude-sonnet-4-6" });
    expect(out.masterModel).toBe("claude-sonnet-4-6");
    expect(s.workerModel()).toBe(config.workerModel); // untouched key keeps its default

    s.apply({ masterModel: null as unknown as string }); // null -> key deleted -> reverts to default
    expect(s.masterModel()).toBe(config.masterModel);
  });

  it("linearApiKey: set, get, and clear", () => {
    const s = new Settings(new Repositories(openDb(":memory:")), config);
    expect(s.linearApiKey()).toBeUndefined();
    s.setLinearApiKey("lin_abc");
    expect(s.linearApiKey()).toBe("lin_abc");
    s.setLinearApiKey(undefined);
    expect(s.linearApiKey()).toBeUndefined();
  });

  it("linearApiKey falls back to config env value; DB overrides", () => {
    const s = new Settings(new Repositories(openDb(":memory:")), loadConfig({ ROOKERY_LINEAR_API_KEY: "env_key" }));
    expect(s.linearApiKey()).toBe("env_key");
    s.setLinearApiKey("db_key");
    expect(s.linearApiKey()).toBe("db_key");
  });

  it("anthropicApiKey: DB-first, env fallback, write-only (not echoed)", () => {
    const repos = new Repositories(openDb(":memory:"));
    const cfg = config;
    // Settings built with config.anthropicApiKey = "env-key" (env fallback)
    const s = new Settings(repos, { ...cfg, anthropicApiKey: "env-key" } as any);
    expect(s.anthropicApiKey()).toBe("env-key"); // env fallback
    s.setAnthropicApiKey("db-key");
    expect(s.anthropicApiKey()).toBe("db-key"); // DB-first
    expect(Object.keys(s.all())).not.toContain("anthropicApiKey"); // write-only
    s.setAnthropicApiKey(undefined);
    expect(s.anthropicApiKey()).toBe("env-key"); // delete reverts to env
  });

  it("codexApiKey: write-only (not echoed), no env/config fallback", () => {
    const repos = new Repositories(openDb(":memory:"));
    const s = new Settings(repos, config);
    expect(s.codexApiKey()).toBeUndefined(); // unset default (no env fallback, unlike anthropicApiKey)
    s.setCodexApiKey("sk-test");
    expect(s.codexApiKey()).toBe("sk-test");
    expect(Object.keys(s.all())).not.toContain("codexApiKey"); // write-only
    s.setCodexApiKey(undefined);
    expect(s.codexApiKey()).toBeUndefined();
  });

  it("hasAcceptedDataNotice: default 0, echoed in all()", () => {
    const cfg = config;
    const s = new Settings(new Repositories(openDb(":memory:")), cfg);
    expect(s.hasAcceptedDataNotice()).toBe("0");
    s.apply({ hasAcceptedDataNotice: "1" });
    expect(s.hasAcceptedDataNotice()).toBe("1");
    expect(s.all().hasAcceptedDataNotice).toBe("1"); // echoed
  });

  it("onboardingDone: default 0, echoed in all()", () => {
    const s = new Settings(new Repositories(openDb(":memory:")), config);
    expect(s.onboardingDone()).toBe("0");
    s.apply({ onboardingDone: "1" });
    expect(s.all().onboardingDone).toBe("1");
  });

  it("workerSlackRelay settings: defaults off/empty, echoed in all()", () => {
    const s = new Settings(new Repositories(openDb(":memory:")), config);
    expect(s.workerSlackRelayEnabled()).toBe("0");
    expect(s.workerSlackRelayChannel()).toBe("");
    s.apply({ workerSlackRelayEnabled: "1", workerSlackRelayChannel: "C0123" });
    expect(s.all().workerSlackRelayEnabled).toBe("1");
    expect(s.all().workerSlackRelayChannel).toBe("C0123");
  });

  it("defaultSessionCwd: raw is '' when unset (resolver falls back to process.cwd()), echoes the raw set value", () => {
    const s = new Settings(new Repositories(openDb(":memory:")), config);
    expect(s.defaultSessionCwdRaw()).toBe(""); // unset → empty (so the UI can tell)
    expect(s.defaultSessionCwd()).toBe(process.cwd()); // resolver fallback
    expect(s.all().defaultSessionCwd).toBe(""); // all() echoes the raw value
    s.apply({ defaultSessionCwd: "/work/proj" });
    expect(s.defaultSessionCwd()).toBe("/work/proj");
    expect(s.all().defaultSessionCwd).toBe("/work/proj");
  });

  it("applyApiKeyToEnv sets process.env when a key exists, leaves it otherwise", () => {
    const cfg = config;
    const prev = process.env.ANTHROPIC_API_KEY;
    try {
      delete process.env.ANTHROPIC_API_KEY;
      const s = new Settings(new Repositories(openDb(":memory:")), cfg);
      s.setAnthropicApiKey("db-key");
      applyApiKeyToEnv(s);
      expect(process.env.ANTHROPIC_API_KEY).toBe("db-key");
      delete process.env.ANTHROPIC_API_KEY;
      const s2 = new Settings(new Repositories(openDb(":memory:")), { ...cfg, anthropicApiKey: undefined } as any);
      applyApiKeyToEnv(s2);
      expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });
});
