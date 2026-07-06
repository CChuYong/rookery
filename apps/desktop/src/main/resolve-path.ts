// A Finder/LaunchServices-launched .app inherits launchd's minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin),
// NOT a login-shell PATH — so a bare `codex`/`gh` (the settings default codexBin) ENOENTs on every spawn
// even though the same binary runs fine from a terminal (codex-parity finding [3]). Merge the well-known
// CLI install dirs onto PATH so the daemon child — and the codex/gh grandchildren it spawns, which inherit
// this env — can resolve them. Deterministic (no `$SHELL -lic` login-shell probe that could hang or leak a
// process); a user whose codex lives somewhere exotic can still set an absolute codexBin in Settings.
// Extras are APPENDED (not prepended) so they never shadow a system binary of the same name.
export function withResolvedPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  home: string | undefined = env.HOME,
): NodeJS.ProcessEnv {
  if (platform === "win32") return env; // Windows resolution/installers differ; the launchd-PATH gap is macOS/Linux
  const sep = ":";
  const extra = [
    "/opt/homebrew/bin", // Apple-silicon Homebrew
    "/usr/local/bin", // Intel Homebrew / common /usr/local installs
    ...(home ? [`${home}/.local/bin`, `${home}/.npm-global/bin`, `${home}/.bun/bin`, `${home}/bin`] : []),
  ];
  const seen = new Set((env.PATH ?? "").split(sep).filter(Boolean));
  const additions = extra.filter((d) => !seen.has(d));
  if (additions.length === 0) return env;
  const merged = [...(env.PATH ? [env.PATH] : []), ...additions].join(sep);
  return { ...env, PATH: merged };
}
