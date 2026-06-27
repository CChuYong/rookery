import type { Config } from "../config.js";
import type { Repositories } from "../persistence/repositories.js";
import { resolveLocale } from "./i18n.js";

// The default the master uses as its own name in the system prompt. masterName is a settings-only value with no env/config fallback,
// so we keep it as a constant here (unlike other values, no config.* fallback).
export const DEFAULT_MASTER_NAME = "rookery";
export const DEFAULT_USAGE_REFRESH_MS = 120000;
export const DEFAULT_SLACK_REFUSAL = "Sorry, you're not authorized to use this bot."; // default refusal reply for non-allowed users

// Settings that can be changed at runtime. Use the value stored in the DB (settings table) if present, otherwise the config/hardcoded default.
// All kept as strings (parsing happens on the consumer side) → keeps SettingsPatch/the protocol simple. Slack tokens are secret, so they're not here (separate setter).
export interface SettingsValues {
  masterName: string;
  masterModel: string;
  workerModel: string;
  masterEffort: string;
  workerEffort: string;
  slackCwd: string; // cwd for Slack-originated sessions (settings-only, defaults to process.cwd())
  slackAllowedUsers: string; // user ids allowed to get responses (comma-separated, settings-only)
  slackAllowAll: string; // "1" allows everyone (settings-only, fail-closed default "0")
  slackRefuseReply: string; // whether to auto-reply to non-allowed users ("1"/"0", default "1")
  slackRefusalMessage: string; // refusal reply message
  slackLocale: string; // Slack output language ("ko"/"en", settings-only, default "ko")
  usageRefreshMs: string; // usage refresh interval (ms, settings-only). Applied at boot.
  hasAcceptedDataNotice: string; // first-run data-transmission consent flag ("1" accepted, default "0"). Not secret → echoed.
}

// null = delete that key to revert to the config default (apply's deleteSetting path). linearApiKey/anthropicApiKey are outside SettingsValues (write-only secrets), so they're separate.
export type SettingsPatch = { [K in keyof SettingsValues]?: string | null } & { linearApiKey?: string | null; anthropicApiKey?: string | null };

export class Settings {
  constructor(
    private readonly repos: Repositories,
    private readonly config: Config,
  ) {}

  // Bot name (settings-only, no env/config fallback). Normalized on read via trim + 64-char cap → falls back to the default if empty.
  // all() goes through this getter, so the normalized value is echoed straight to the UI.
  masterName(): string {
    const raw = (this.repos.getSetting("masterName") ?? "").trim();
    return raw ? raw.slice(0, 64) : DEFAULT_MASTER_NAME;
  }

  masterModel(): string {
    return this.repos.getSetting("masterModel") ?? this.config.masterModel;
  }

  workerModel(): string {
    return this.repos.getSetting("workerModel") ?? this.config.workerModel;
  }

  masterEffort(): string {
    return this.repos.getSetting("masterEffort") ?? this.config.masterEffort;
  }

  workerEffort(): string {
    return this.repos.getSetting("workerEffort") ?? this.config.workerEffort;
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
  // First-run data-transmission consent flag ("1" accepted). Echoed (not secret).
  hasAcceptedDataNotice(): string {
    return this.repos.getSetting("hasAcceptedDataNotice") ?? "0";
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
  usageRefreshMs(): string {
    return this.repos.getSetting("usageRefreshMs") ?? String(DEFAULT_USAGE_REFRESH_MS);
  }

  all(): SettingsValues {
    return {
      masterName: this.masterName(),
      masterModel: this.masterModel(),
      workerModel: this.workerModel(),
      masterEffort: this.masterEffort(),
      workerEffort: this.workerEffort(),
      slackCwd: this.slackCwd(),
      slackAllowedUsers: this.slackAllowedUsers(),
      slackAllowAll: this.slackAllowAll(),
      slackRefuseReply: this.slackRefuseReply(),
      slackRefusalMessage: this.slackRefusalMessage(),
      slackLocale: this.slackLocale(),
      usageRefreshMs: this.usageRefreshMs(),
      hasAcceptedDataNotice: this.hasAcceptedDataNotice(),
    };
  }

  // Apply a partial patch. null deletes that key (= reverts to the default).
  apply(patch: SettingsPatch): SettingsValues {
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === undefined) this.repos.deleteSetting(key);
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
