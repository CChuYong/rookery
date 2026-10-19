import type { CodexClient } from "./codex-client.js";

// Codex CLI version policy. The app-server `initialize` response carries
// `userAgent: "<clientInfo.name>/<codex version> (<os>; <arch>) <terminal> (<name>; <version>)"`
// (live-verified 0.144.1 / 0.146.1 / 0.151.0 / 0.163.0: "rookery/0.163.0 (Mac OS 15.7.3; arm64) ...").
export type CodexVersion = readonly [major: number, minor: number, patch: number];

// Oldest CLI the curated protocol types are written against and tested to work with.
export const MIN_CODEX_VERSION: CodexVersion = [0, 146, 1];
// First CLI that accepts `thread/resume|fork { excludeTurns }` WITHOUT the experimentalApi
// capability (bisected live: 0.150.1 rejects with -32600 "requires experimentalApi capability",
// 0.151.0 accepts). Older CLIs must not be sent the param.
export const EXCLUDE_TURNS_MIN_VERSION: CodexVersion = [0, 151, 0];

export function formatVersion(v: CodexVersion): string {
  return v.join(".");
}

export interface ParsedCodexVersion {
  version: CodexVersion;
  prerelease: boolean; // "-alpha.N" etc. — sorts BELOW the same X.Y.Z release (semver)
}

// Defensive parse of `initialize.userAgent`: the token after the first "/" up to whitespace, read as
// semver (build metadata ignored, a pre-release suffix is kept as a flag). Anything unrecognizable —
// including the placeholder `0.0.0` that source/dev builds report — → null (caller allows + logs).
export function parseCodexVersion(userAgent: unknown): ParsedCodexVersion | null {
  if (typeof userAgent !== "string") return null;
  const m = /^[^/\s]+\/(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?/.exec(userAgent.trim());
  if (!m) return null;
  const version: CodexVersion = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (version[0] === 0 && version[1] === 0 && version[2] === 0) return null;
  return { version, prerelease: m[4] !== undefined };
}

// Numeric X.Y.Z comparison (pre-release ignored).
export function compareVersions(a: CodexVersion, b: CodexVersion): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  return 0;
}

// Strict semver: `X.Y.Z-pre` < `X.Y.Z`. Used for feature gates (excludeTurns), where a pre-release of the
// first accepting version may not have the feature yet. The MIN-version check stays lenient (ignores
// the pre-release flag) so a pre-release build of the minimum is not rejected.
export function compareParsed(a: ParsedCodexVersion, b: CodexVersion): number {
  const c = compareVersions(a.version, b);
  return c !== 0 ? c : a.prerelease ? -1 : 0;
}

export class CodexVersionError extends Error {
  constructor(readonly found: CodexVersion) {
    super(`Codex CLI ${formatVersion(found)} is older than the minimum supported ${formatVersion(MIN_CODEX_VERSION)}. Upgrade it (e.g. \`npm i -g @openai/codex@latest\`) and retry.`);
    this.name = "CodexVersionError";
  }
}

let warnedUnparseable = false;

export interface CodexHandshake {
  version: CodexVersion | null;
  // Whether this child accepts `excludeTurns` on thread/resume|fork. Unknown version → false (safe).
  supportsExcludeTurns: boolean;
}

// Pure evaluation of an `initialize` result: throws CodexVersionError below the minimum; an
// unparseable userAgent is allowed (logged once per process) rather than blocking.
export function evaluateInitialize(result: unknown): CodexHandshake {
  const parsed = parseCodexVersion((result as { userAgent?: unknown } | null | undefined)?.userAgent);
  if (!parsed) {
    if (!warnedUnparseable) {
      warnedUnparseable = true;
      console.warn("[codex] could not parse the Codex CLI version from the initialize response; skipping the minimum-version check");
    }
    return { version: null, supportsExcludeTurns: false };
  }
  const { version } = parsed;
  if (compareVersions(version, MIN_CODEX_VERSION) < 0) throw new CodexVersionError(version);
  return { version, supportsExcludeTurns: compareParsed(parsed, EXCLUDE_TURNS_MIN_VERSION) >= 0 };
}

// thread/resume | thread/fork with `excludeTurns` when `state.supported`; if the child rejects it as
// experimental (-32600 "... requires experimentalApi capability" — e.g. a pre-release build or a version
// misjudged by the gate), retry ONCE without it and remember that for this client's lifetime.
export async function requestExcludingTurns(client: CodexClient, state: { supported: boolean }, method: string, params: Record<string, unknown>): Promise<unknown> {
  if (!state.supported) return client.request(method, params);
  try {
    return await client.request(method, { ...params, excludeTurns: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/-32600/.test(msg) || !/experimentalApi/i.test(msg)) throw err;
    state.supported = false;
    return client.request(method, params);
  }
}

// Shared `initialize` + `initialized` handshake for the backend's spawn paths.
export async function initializeCodex(client: CodexClient, clientInfo: { name: string; title: string; version: string }): Promise<CodexHandshake> {
  const res = await client.request("initialize", { clientInfo, capabilities: { experimentalApi: false, requestAttestation: false } });
  const hs = evaluateInitialize(res);
  client.notify("initialized", {});
  return hs;
}

export function __resetCodexVersionWarningForTests(): void {
  warnedUnparseable = false;
}
