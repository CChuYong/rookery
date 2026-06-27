import type { SlashCommandInfo } from "./commands.js";
import { t, DEFAULT_LOCALE, type KO } from "./i18n.js";

// Classify the system push (type:"system") the SDK streams into a form we can react to.
// commands_changed → refresh the command/skill list; other informational pushes → a one-line notice to show in the conversation.
// Notices carry a structured code+params (so clients can re-localize) plus a text pre-rendered at DEFAULT_LOCALE for dumb consumers (worker transcript, persistence).
export type NoticeCode = keyof typeof KO;
export type SystemPush =
  | { kind: "commands"; commands: SlashCommandInfo[] }
  | { kind: "notice"; code: NoticeCode; params?: Record<string, string | number>; text: string };

function fmtK(n: number | undefined): string {
  if (n == null) return "?";
  return n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n);
}

// Build a notice from a code + params, pre-rendering text at the default locale.
function notice(code: NoticeCode, params?: Record<string, string | number>): SystemPush {
  return { kind: "notice", code, params, text: t(DEFAULT_LOCALE, code, params) };
}

export function classifySystemPush(msg: unknown): SystemPush | null {
  const m = msg as { subtype?: string; [k: string]: unknown };
  switch (m.subtype) {
    case "commands_changed": {
      const cmds = (m.commands as SlashCommandInfo[] | undefined) ?? [];
      return { kind: "commands", commands: cmds.map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint, aliases: c.aliases })) };
    }
    case "compact_boundary": {
      const meta = (m.compact_metadata as { trigger?: string; pre_tokens?: number; post_tokens?: number } | undefined) ?? {};
      const span = meta.post_tokens != null ? `${fmtK(meta.pre_tokens)}→${fmtK(meta.post_tokens)}` : fmtK(meta.pre_tokens);
      return notice("notice.compact", { trigger: meta.trigger ?? "auto", span });
    }
    case "api_retry":
      return notice("notice.apiRetry", { attempt: String(m.attempt ?? "?"), max: String(m.max_retries ?? "?"), error: String(m.error ?? "error") });
    case "model_refusal_fallback":
      return notice("notice.modelFallback", { from: String(m.original_model ?? "?"), to: String(m.fallback_model ?? "?"), reason: String(m.api_refusal_category ?? "refusal") });
    case "memory_recall": {
      const mems = (m.memories as unknown[] | undefined) ?? [];
      return mems.length > 0 ? notice("notice.memoryRecall", { count: mems.length }) : null;
    }
    case "notification": {
      const text = typeof m.text === "string" ? m.text : "";
      return text ? notice("notice.notification", { text }) : null;
    }
    case "status":
      // compacting/requesting are too frequent, so exclude them. Surface only compaction failures.
      return m.compact_result === "failed" ? notice("notice.compactFailed", { detail: m.compact_error ? `: ${String(m.compact_error)}` : "" }) : null;
    case "session_state_changed":
      // idle/running overlap with our state machine → notify only on requires_action.
      return m.state === "requires_action" ? notice("notice.requiresAction") : null;
    default:
      return null; // other system messages such as init keep their existing handling (or are ignored)
  }
}
