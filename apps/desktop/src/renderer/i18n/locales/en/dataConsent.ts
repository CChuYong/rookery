import type { Catalog } from "../../types.js";
export default {
  "dataConsent.title": "Data Transmission Notice",
  "dataConsent.body": "This app sends your prompts, repository code & diffs, and (when Slack is connected) channel text to your chosen LLM provider — Anthropic (Claude) by default, or OpenAI for any session, worker, automation, or Slack thread set to the codex backend. Local data is stored in ~/.rookery.",
  "dataConsent.accept": "Accept & Continue",
  "dataConsent.saveFailed": "Couldn't save — please try again.",
} satisfies Catalog;
