import type { SpeedPreference } from "./speed.js";
import type { Config } from "../config.js";
import type { Repositories } from "../persistence/repositories.js";
import { resolveLocale } from "./i18n.js";

// The default the master uses as its own name in the system prompt. masterName is a settings-only value with no env/config fallback,
// so we keep it as a constant here (unlike other values, no config.* fallback).
export const DEFAULT_MASTER_NAME = "rookery";
export const DEFAULT_USAGE_REFRESH_MS = 120000;
export const DEFAULT_SLACK_REFUSAL = "Sorry, you're not authorized to use this bot."; // default refusal reply for non-allowed users
// Codex worker backend defaults (P1, settings-only — no env/config fallback, unlike workerModel/workerEffort).
// No codexApiKey: the app-server ignores CODEX_API_KEY env; auth relies on the user's ~/.codex/auth.json (`codex login`).
export const DEFAULT_CODEX_WORKER_MODEL = "gpt-6.1-sol";
// Codex master default model (P2, settings-only — mirrors codexWorkerModel/DEFAULT_CODEX_WORKER_MODEL's
// "no env/config fallback" convention; symmetric master/worker split, same default value).
export const DEFAULT_CODEX_MASTER_MODEL = "gpt-6.1-sol";
export const DEFAULT_CODEX_BIN = "codex";
// Codex per-turn inactivity watchdog default (P2.5 Track B, settings-only — mirrors
// DEFAULT_USAGE_REFRESH_MS's shape: a raw string in the settings table/echoed SettingsValues, ""
// meaning "use the default"). Default off; users who want the watchdog can opt in with a positive ms value.
export const DEFAULT_CODEX_TURN_IDLE_TIMEOUT_MS = 0;
// Codex pre-turn handshake+thread-start timeout default (P3-remaining Track A — a child wedged
// during openClient (spawn+initialize+provisioning) or startOrResumeThread never trips the
// per-turn idle watchdog above, since that only arms AFTER turn/start's response). Mirrors
// DEFAULT_CODEX_TURN_IDLE_TIMEOUT_MS's shape exactly. Generous default for a cold Rust-binary
// spawn + auth; 0 (or non-positive) disables it entirely.
export const DEFAULT_CODEX_HANDSHAKE_TIMEOUT_MS = 30000;

// Settings that can be changed at runtime. Use the value stored in the DB (settings table) if present, otherwise the config/hardcoded default.
// All kept as strings (parsing happens on the consumer side) → keeps SettingsPatch/the protocol simple. Slack tokens are secret, so they're not here (separate setter).
export interface SettingsValues {
  masterSpeed?: SpeedPreference;
  workerSpeed?: SpeedPreference;
  codexMasterSpeed?: SpeedPreference;
  codexWorkerSpeed?: SpeedPreference;
  masterName: string;
  masterModel: string; // the effective Claude master default (what a new session gets)
  workerModel: string; // the effective Claude worker default (what a new worker gets)
  // Read-only: where masterModel/workerModel came from. "recommended" = the SDK's recommended model for this
  // account, "fallback" = recommendation not known yet (configured default), "env" = ROOKERY_*_MODEL,
  // "setting" = saved in Settings. Not writable through settings.set.
  masterModelSource?: ClaudeModelSource;
  workerModelSource?: ClaudeModelSource;
  claudeRecommendedModel?: string; // read-only: the SDK's recommended Claude model id, "" while unknown
  masterEffort: string;
  workerEffort: string;
  codexWorkerModel: string; // codex worker default model (settings-only, no env/config fallback). default "gpt-6.1-sol".
  codexMasterModel: string; // codex master default model (settings-only, no env/config fallback). default "gpt-6.1-sol".
  codexBin: string; // codex CLI binary/path used to spawn `codex app-server` (settings-only). default "codex".
  codexTurnIdleTimeoutMs: string; // per-turn codex watchdog inactivity timeout, ms as a raw string (settings-only). 0 disables. default "0".
  codexHandshakeTimeoutMs: string; // pre-turn codex handshake+thread-start timeout, ms as a raw string (settings-only). 0 disables. default "30000".
  slackCwd: string; // cwd for Slack-originated sessions (settings-only, defaults to process.cwd())
  slackAllowedUsers: string; // user ids allowed to get responses (comma-separated, settings-only)
  slackAllowAll: string; // "1" allows everyone (settings-only, fail-closed default "0")
  slackRefuseReply: string; // whether to auto-reply to non-allowed users ("1"/"0", default "1")
  slackRefusalMessage: string; // refusal reply message
  slackLocale: string; // Slack output language ("ko"/"en", settings-only, default "ko")
  slackProvider: string; // AgentBackend for slack-origin master sessions ("claude"/"codex", settings-only, default "claude"). Opt-in — a codex slack session inherits the P2 bypassPermissions-only codex-master guard.
  usageRefreshMs: string; // usage refresh interval (ms, settings-only). Applied at boot.
  hasAcceptedDataNotice: string; // first-run data-transmission consent flag ("1" accepted, default "0"). Not secret → echoed.
  onboardingDone: string; // first-run onboarding completed flag ("1" done, default "0"). Not secret → echoed.
  defaultSessionCwd: string; // default cwd for desktop sessions when none is picked (raw value, "" if unset; resolver falls back to process.cwd()). Not secret → echoed.
  workerSlackRelayEnabled: string; // mirror Slack-origin masters' worker activity to a channel ("1"/"0", default "0"). Echoed.
  workerSlackRelayChannel: string; // Slack channel ID for the worker relay ("" = off even if enabled). Echoed.
  workerCostBudgetUsd: string; // default lifetime USD cost ceiling applied to spawned workers when a spawn has no explicit override (settings-only). "" = unlimited (off). Echoed.
  mcpExposure: string; // External MCP server exposure tier ("off"|"readonly"|"full", settings-only, fail-closed default "off"). Echoed.
}

export type McpScope = "off" | "readonly" | "full";
export type ClaudeModelSource = "setting" | "env" | "recommended" | "fallback";

// Derived, echo-only fields: never stored, so they are not part of a patch.
type ReadOnlySettingKey = "masterModelSource" | "workerModelSource" | "claudeRecommendedModel";

// null = delete that key to revert to the config default (apply's deleteSetting path). linearApiKey/anthropicApiKey/codexApiKey are outside SettingsValues (write-only secrets), so they're separate.
export type SettingsPatch = { [K in Exclude<keyof SettingsValues, ReadOnlySettingKey>]?: string | null } & { linearApiKey?: string | null; anthropicApiKey?: string | null; codexApiKey?: string | null };

// Model settings where "" means "not set" (follow the recommendation) rather than a stored value.
const CLAUDE_MODEL_KEYS = new Set(["masterModel", "workerModel"]);

export class Settings {
  constructor(
    private readonly repos: Repositories,
    private readonly config: Config,
    // The SDK's recommended Claude model (ClaudeModelCatalog.recommended), used when neither a saved setting nor
    // ROOKERY_*_MODEL picks one. Resolved on every read, so a newly learned recommendation applies at the next turn.
    private readonly deps: { recommendedClaudeModel?: () => string | null } = {},
  ) {}

  private claudeModel(key: "masterModel" | "workerModel"): { model: string; source: ClaudeModelSource } {
    const saved = this.repos.getSetting(key)?.trim();
    if (saved) return { model: saved, source: "setting" };
    const fromEnv = key === "masterModel" ? this.config.masterModelFromEnv : this.config.workerModelFromEnv;
    const configured = key === "masterModel" ? this.config.masterModel : this.config.workerModel;
    if (fromEnv) return { model: configured, source: "env" };
    const recommended = this.deps.recommendedClaudeModel?.() ?? null;
    return recommended ? { model: recommended, source: "recommended" } : { model: configured, source: "fallback" };
  }

  // Bot name (settings-only, no env/config fallback). Normalized on read via trim + 64-char cap → falls back to the default if empty.
  // all() goes through this getter, so the normalized value is echoed straight to the UI.
  masterName(): string {
    const raw = (this.repos.getSetting("masterName") ?? "").trim();
    return raw ? raw.slice(0, 64) : DEFAULT_MASTER_NAME;
  }

  speed(provider: string, role: "master" | "worker"): SpeedPreference {
    const key = provider === "codex" ? (role === "master" ? "codexMasterSpeed" : "codexWorkerSpeed") : (role === "master" ? "masterSpeed" : "workerSpeed");
    return this.repos.getSetting(key) === "fast" ? "fast" : "standard";
  }

  // Saved setting > ROOKERY_MASTER_MODEL > the SDK's recommended model > configured default.
  masterModel(): string {
    return this.claudeModel("masterModel").model;
  }

  workerModel(): string {
    return this.claudeModel("workerModel").model;
  }

  masterEffort(): string {
    return this.repos.getSetting("masterEffort") ?? this.config.masterEffort;
  }

  workerEffort(): string {
    return this.repos.getSetting("workerEffort") ?? this.config.workerEffort;
  }

  codexWorkerModel(): string {
    return this.repos.getSetting("codexWorkerModel") ?? DEFAULT_CODEX_WORKER_MODEL;
  }

  codexMasterModel(): string {
    return this.repos.getSetting("codexMasterModel") ?? DEFAULT_CODEX_MASTER_MODEL;
  }

  codexBin(): string {
    return this.repos.getSetting("codexBin") ?? DEFAULT_CODEX_BIN;
  }

  // Per-turn codex watchdog inactivity timeout (P2.5 Track B — docs/2026-07-06-p25-codex-hardening.md).
  // Unlike other numeric-ish settings (e.g. usageRefreshMs, which stays a raw string echoed via
  // all() and is parsed by its one consumer at the server.ts call site), this getter returns the
  // PARSED number directly: it's injected straight into CodexBackendDeps.idleTimeoutMs (`() =>
  // number`), which codex-backend.ts calls fresh every turn (the model/effort resolver convention —
  // re-evaluated per turn, not snapshotted). Missing setting → the default; present but non-numeric
  // → also the default (fail safe, never NaN). "0" (or a negative override) is a valid, DELIBERATE
  // value meaning "disable the watchdog" and is passed through as-is, not coerced to the default.
  codexTurnIdleTimeoutMs(): number {
    const raw = this.repos.getSetting("codexTurnIdleTimeoutMs");
    if (raw === undefined) return DEFAULT_CODEX_TURN_IDLE_TIMEOUT_MS;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : DEFAULT_CODEX_TURN_IDLE_TIMEOUT_MS;
  }

  // Pre-turn codex handshake+thread-start timeout (P3-remaining Track A). Same shape/contract as
  // codexTurnIdleTimeoutMs above: returns the PARSED number directly (injected into
  // CodexBackendDeps.handshakeTimeoutMs, resolved fresh per stream). Missing/non-numeric → the
  // default (fail safe, never NaN); "0" (or negative) is a deliberate, valid disable value.
  codexHandshakeTimeoutMs(): number {
    const raw = this.repos.getSetting("codexHandshakeTimeoutMs");
    if (raw === undefined) return DEFAULT_CODEX_HANDSHAKE_TIMEOUT_MS;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : DEFAULT_CODEX_HANDSHAKE_TIMEOUT_MS;
  }

  // Linear API key (integration secret). Kept out of SettingsValues to isolate it from being echoed via settings.result.
  linearApiKey(): string | undefined {
    return this.repos.getSetting("linearApiKey") ?? this.config.linearApiKey;
  }

  setLinearApiKey(key: string | undefined): void {
    if (!key) this.repos.deleteSetting("linearApiKey");
    else this.repos.setSetting("linearApiKey", key);
  }

  // Anthropic API key (secret). DB first, env (config) fallback. write-only (not echoed via settings.result).
  anthropicApiKey(): string | undefined {
    return this.repos.getSetting("anthropicApiKey") ?? this.config.anthropicApiKey;
  }
  setAnthropicApiKey(key: string | undefined): void {
    if (!key) this.repos.deleteSetting("anthropicApiKey");
    else this.repos.setSetting("anthropicApiKey", key);
  }

  // Codex in-app API key (secret, DB-only — no env/config fallback, unlike anthropicApiKey). write-only (not echoed via settings.result).
  // When set, the daemon redirects codex children to a rookery-managed CODEX_HOME and provisions
  // auth.json via account/login/start (the app-server ignores CODEX_API_KEY env — see codex-transport.ts AUTH NOTE).
  codexApiKey(): string | undefined {
    return this.repos.getSetting("codexApiKey");
  }
  setCodexApiKey(key: string | undefined): void {
    if (!key) this.repos.deleteSetting("codexApiKey");
    else this.repos.setSetting("codexApiKey", key);
  }
  // First-run data-transmission consent flag ("1" accepted). Echoed (not secret).
  hasAcceptedDataNotice(): string {
    return this.repos.getSetting("hasAcceptedDataNotice") ?? "0";
  }

  // First-run onboarding completed flag ("1" done). Echoed (not secret).
  onboardingDone(): string {
    return this.repos.getSetting("onboardingDone") ?? "0";
  }

  // Default cwd for desktop-started sessions when none is picked. defaultSessionCwd() falls back to process.cwd()
  // (used by the daemon when creating a session); defaultSessionCwdRaw() is the bare configured value ("" if unset)
  // so the UI/onboarding can tell whether it has been set, and it's the value echoed via all().
  defaultSessionCwdRaw(): string {
    return this.repos.getSetting("defaultSessionCwd")?.trim() ?? "";
  }
  defaultSessionCwd(): string {
    return this.defaultSessionCwdRaw() || process.cwd();
  }

  // Worker → Slack relay: when enabled with a channel set, each Slack-origin master's workers are mirrored to that channel.
  workerSlackRelayEnabled(): string {
    return this.repos.getSetting("workerSlackRelayEnabled") ?? "0";
  }
  workerSlackRelayChannel(): string {
    return this.repos.getSetting("workerSlackRelayChannel")?.trim() ?? "";
  }

  // Default lifetime USD cost ceiling applied to a spawned worker when the spawn itself has no explicit
  // costBudgetUsd override (server.ts subFactory: override ?? this default ?? unlimited). Default OFF
  // (null = unlimited) — opt-in, unlike codexTurnIdleTimeoutMs/codexHandshakeTimeoutMs which always have a
  // positive numeric default. Missing, empty, non-positive ("0"/negative), or malformed → null (fail safe:
  // a bad value must never silently arm a stop-everything guard).
  workerCostBudgetUsd(): number | null {
    const raw = this.repos.getSetting("workerCostBudgetUsd");
    if (!raw) return null;
    // Number(), not parseFloat: parseFloat tolerates trailing garbage ("5x" -> 5), which is inconsistent
    // with the UI's Number() validation. Number("5x") -> NaN, so it falls through to null below.
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  // Slack bot/app tokens (secret). DB first, falling back to env (config) if absent — headless/CI compatible. write-only (not echoed).
  slackBotToken(): string | undefined {
    return this.repos.getSetting("slackBotToken") ?? this.config.slack.botToken;
  }
  slackAppToken(): string | undefined {
    return this.repos.getSetting("slackAppToken") ?? this.config.slack.appToken;
  }
  setSlackBotToken(token: string | undefined): void {
    if (!token) this.repos.deleteSetting("slackBotToken");
    else this.repos.setSetting("slackBotToken", token);
  }
  setSlackAppToken(token: string | undefined): void {
    if (!token) this.repos.deleteSetting("slackAppToken");
    else this.repos.setSetting("slackAppToken", token);
  }
  // Are both tokens present (DB or env)? SlackController's configured gate.
  slackConfigured(): boolean {
    return Boolean(this.slackBotToken() && this.slackAppToken());
  }

  // Slack/usage settings (all settings-only, no env/config fallback). Stored and echoed as raw strings, parsed on the consumer side.
  slackCwd(): string {
    return this.repos.getSetting("slackCwd")?.trim() || process.cwd();
  }
  slackAllowedUsers(): string {
    return this.repos.getSetting("slackAllowedUsers") ?? "";
  }
  slackAllowAll(): string {
    return this.repos.getSetting("slackAllowAll") ?? "0";
  }
  slackRefuseReply(): string {
    return this.repos.getSetting("slackRefuseReply") ?? "1"; // default on (preserves current behavior)
  }
  slackRefusalMessage(): string {
    return this.repos.getSetting("slackRefusalMessage") ?? DEFAULT_SLACK_REFUSAL;
  }
  slackLocale(): string {
    return resolveLocale(this.repos.getSetting("slackLocale"));
  }
  // AgentBackend for slack-origin sessions (P2.5 Track C). Mirrors slackLocale's coercion shape: any
  // stored value other than exactly "codex" (missing, cleared, or garbage) falls back to "claude" — this
  // is the opt-in switch that puts a Slack thread's master session on a codex backend (bridge + read_thread
  // via toolDefs, see slack/capabilities.ts), so an unrecognized value must never silently become codex.
  slackProvider(): "claude" | "codex" {
    return this.repos.getSetting("slackProvider") === "codex" ? "codex" : "claude";
  }
  usageRefreshMs(): string {
    return this.repos.getSetting("usageRefreshMs") ?? String(DEFAULT_USAGE_REFRESH_MS);
  }

  // External MCP server exposure tier. Fail-closed like slackAllowAll: any stored value other than
  // exactly "readonly"/"full" (missing, cleared, or garbage) falls back to "off" — an unrecognized
  // value must never silently expose the bypassPermissions fleet to external MCP clients.
  mcpExposure(): McpScope {
    const v = this.repos.getSetting("mcpExposure");
    return v === "readonly" || v === "full" ? v : "off";
  }

  all(): SettingsValues {
    const wcb = this.workerCostBudgetUsd(); // hoisted: avoid calling the getter twice for the same field below
    const master = this.claudeModel("masterModel");
    const worker = this.claudeModel("workerModel");
    return {
      masterSpeed: this.speed("claude", "master"),
      workerSpeed: this.speed("claude", "worker"),
      codexMasterSpeed: this.speed("codex", "master"),
      codexWorkerSpeed: this.speed("codex", "worker"),
      masterName: this.masterName(),
      masterModel: master.model,
      workerModel: worker.model,
      masterModelSource: master.source,
      workerModelSource: worker.source,
      claudeRecommendedModel: this.deps.recommendedClaudeModel?.() ?? "",
      masterEffort: this.masterEffort(),
      workerEffort: this.workerEffort(),
      codexWorkerModel: this.codexWorkerModel(),
      codexMasterModel: this.codexMasterModel(),
      codexBin: this.codexBin(),
      codexTurnIdleTimeoutMs: String(this.codexTurnIdleTimeoutMs()), // echoed as a raw string, mirroring usageRefreshMs's shape
      codexHandshakeTimeoutMs: String(this.codexHandshakeTimeoutMs()), // echoed as a raw string, same shape
      slackCwd: this.slackCwd(),
      slackAllowedUsers: this.slackAllowedUsers(),
      slackAllowAll: this.slackAllowAll(),
      slackRefuseReply: this.slackRefuseReply(),
      slackRefusalMessage: this.slackRefusalMessage(),
      slackLocale: this.slackLocale(),
      slackProvider: this.slackProvider(),
      usageRefreshMs: this.usageRefreshMs(),
      hasAcceptedDataNotice: this.hasAcceptedDataNotice(),
      onboardingDone: this.onboardingDone(),
      defaultSessionCwd: this.defaultSessionCwdRaw(),
      workerSlackRelayEnabled: this.workerSlackRelayEnabled(),
      workerSlackRelayChannel: this.workerSlackRelayChannel(),
      workerCostBudgetUsd: wcb == null ? "" : String(wcb),
      mcpExposure: this.mcpExposure(),
    };
  }

  // Apply a partial patch. null deletes that key (= reverts to the default).
  apply(patch: SettingsPatch): SettingsValues {
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === undefined) this.repos.deleteSetting(key);
      else if (CLAUDE_MODEL_KEYS.has(key) && String(value).trim() === "") this.repos.deleteSetting(key); // "" = follow the recommendation
      else this.repos.setSetting(key, String(value));
    }
    return this.all();
  }
}

// Inject the in-app API key into process.env so the SDK subprocess (inherits process.env), models-provider, and auth-status pick it up.
// Accepts the structural shape (anthropicApiKey getter) so the daemon Connection's SettingsProvider can call it without depending on the concrete class.
export function applyApiKeyToEnv(settings: { anthropicApiKey(): string | undefined }): void {
  const k = settings.anthropicApiKey();
  if (k) process.env.ANTHROPIC_API_KEY = k;
}
