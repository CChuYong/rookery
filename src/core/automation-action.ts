import { randomBytes } from "node:crypto";
import type { Automation } from "../persistence/repositories.js";
import type { Repositories } from "../persistence/repositories.js";
import { AUTOMATION_FLEET_SESSION_KEY } from "./session-manager.js";

export interface ActionVars { message?: string; channel?: string; user?: string; ts?: string; threadTs?: string; team?: string }
type ActionSession = { id: string; master: { runTurn(t: string, o?: { model?: string; effort?: string; permissionMode?: string; maxTurns?: number; costBudgetUsd?: number }): Promise<void> } };
export interface AutomationActionSessions {
  create(cwd: string, opts?: { origin?: string; originRef?: string | null; provider?: string }): ActionSession;
  getOrCreateByKey(k: string, cwd: string, provider?: string): ActionSession;
  get(id: string): ActionSession | undefined; // self-wakeup: resume the caller's session as-is (if absent → undefined → skip)
}
export interface AutomationActionDeps {
  repos: Pick<Repositories, "getRepoByName">;
  sessions: AutomationActionSessions;
  fleet: { spawn(o: { homeSessionId: string; repoPath: string; label: string; task: string; base?: string; model?: string; effort?: string; permissionMode?: string; maxTurns?: number; costBudgetUsd?: number; provider?: string }): Promise<{ id: string }> };
}

function fence(v: string | undefined, kind: string, nonce: string): string {
  const raw = v ?? "";
  // Prevent the value from reproducing the closing delimiter:
  //   1. Remove any occurrence of the nonce from the value (makes nonce re-use impossible).
  //   2. Insert a Zero-Width Space after the first character of any <untrusted- or </untrusted- literal
  //      so the literal tag sequence can no longer match the real opening/closing tags.
  const safe = raw
    .split(nonce)
    .join("")
    .replace(/<\/?untrusted-/gi, (m) => m[0] + "​" + m.slice(1));
  return `<untrusted-${kind} id="${nonce}">\n${safe}\n</untrusted-${kind} id="${nonce}">`;
}

export function applyVars(s: string, vars: ActionVars): string {
  const nonce = randomBytes(9).toString("base64url"); // ~12 chars, alphanumeric (no regex/HTML metacharacters), one fresh nonce per call
  return s
    .replace(/\{\{message\}\}/g,  () => fence(vars.message,  "slack-message",   nonce))
    .replace(/\{\{channel\}\}/g,  () => fence(vars.channel,  "slack-channel",   nonce))
    .replace(/\{\{user\}\}/g,     () => fence(vars.user,     "slack-user",      nonce))
    .replace(/\{\{ts\}\}/g,       () => fence(vars.ts,       "slack-ts",        nonce))
    .replace(/\{\{threadTs\}\}/g, () => fence(vars.threadTs, "slack-thread-ts", nonce))
    .replace(/\{\{team\}\}/g,     () => fence(vars.team,     "slack-team",      nonce));
}

export async function runAutomationAction(a: Automation, vars: ActionVars, deps: AutomationActionDeps): Promise<void> {
  // provider is a session/worker CREATION attribute (which AgentBackend runs it), not a per-turn override — it is
  // deliberately kept out of `opts` (which is threaded to runTurn/fleet.spawn as turn overrides only).
  const opts = { model: a.model ?? undefined, effort: a.effort ?? undefined, permissionMode: a.permissionMode ?? undefined, maxTurns: a.maxTurns ?? undefined, costBudgetUsd: a.costBudgetUsd ?? undefined };
  if (a.action.kind === "master") {
    const c = a.action;
    // self-wakeup: continue the caller's session as-is (if absent, don't create one — just skip). Otherwise reuse(automation:<id>)/fresh.
    // Note: codex masters are bypassPermissions-only (P2 guard) — a codex automation with a non-bypass
    // permission_mode fails its run with a clear error at turn start (runTurn rejects it); automations default
    // to bypass (permissionMode null → bypassPermissions), so this only bites a deliberate mis-config.
    const session = c.targetSessionId
      ? deps.sessions.get(c.targetSessionId) // provider already fixed on the existing session — unchanged
      : c.sessionMode === "reuse"
        ? deps.sessions.getOrCreateByKey("automation:" + a.id, c.cwd, a.provider) // prefix-derived → origin=automation, ref=id
        : deps.sessions.create(c.cwd, { origin: "automation", originRef: a.id, provider: a.provider }); // fresh: keyless but tagged as automation (per-run session, grouped by id)
    if (!session) return; // target session is gone (deleted, etc.) → silently skip
    await session.master.runTurn(applyVars(c.prompt, vars), opts);
  } else {
    const c = a.action;
    const repo = deps.repos.getRepoByName(c.repo);
    if (!repo) throw new Error(`unknown repo '${c.repo}'`);
    const home = deps.sessions.getOrCreateByKey(AUTOMATION_FLEET_SESSION_KEY, repo.path);
    // Codex workers are unaffected by the bypass-only guard above (workers aren't bypass-guarded).
    await deps.fleet.spawn({ homeSessionId: home.id, repoPath: repo.path, label: repo.name, task: applyVars(c.task, vars), base: c.base, ...opts, provider: a.provider });
  }
}
