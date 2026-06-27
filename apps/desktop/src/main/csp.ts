// Pure decision logic for Electron security hardening — unit-testable without Electron (window-state.ts TDD convention).
// CSP is injected by the main process via onHeadersReceived (index.ts). dev/prod is distinguished by !app.isPackaged.
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

// Daemon WS connect-src: the loopback pair + (if ROOKERY_HOST is non-loopback) that host added on top.
function daemonWs(host?: string): string {
  const out = ["ws://127.0.0.1:*", "ws://localhost:*"];
  if (host && !LOOPBACK.has(host)) out.push(`ws://${host}:*`);
  return out.join(" ");
}

export function buildCsp(opts: { isDev: boolean; host?: string }): string {
  if (!opts.isDev) {
    return [
      "default-src 'self'",
      "script-src 'self' file: blob:", // prod workers/chunks are file:// null origin — 'self' alone matches unreliably
      "worker-src 'self' file: blob:",
      "style-src 'self' 'unsafe-inline'", // xterm/Monaco insertRule/React style — nonce not possible
      "img-src 'self' data: blob:",
      "font-src 'self' file:",
      `connect-src 'self' ${daemonWs(opts.host)}`,
      "object-src 'none'",
      "frame-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join("; ") + ";";
  }
  const devHttp = "http://localhost:* http://127.0.0.1:*"; // covers Vite's attempt to bind 127.0.0.1
  const devWs = "ws://localhost:* ws://127.0.0.1:*"; // dev HMR WS (Vite dev server)
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${devHttp} blob:`, // 'unsafe-eval' is limited to dev HMR
    `worker-src 'self' blob: ${devHttp}`,
    `style-src 'self' 'unsafe-inline' ${devHttp}`,
    `img-src 'self' data: blob: ${devHttp}`,
    `font-src 'self' ${devHttp}`,
    `connect-src 'self' ${daemonWs(opts.host)} ${devWs} ${devHttp}`,
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ") + ";";
}

// Whether top-level navigation is allowed: dev requires an exact dev-server origin match, prod only file:.
export function isAllowedNavigation(target: string, devUrl: string | undefined): boolean {
  if (devUrl) {
    try { return new URL(target).origin === new URL(devUrl).origin; } catch { return false; }
  }
  return target.startsWith("file://");
}

// window.open / target=_blank: deny everything, route only http(s) to the OS browser (shell.openExternal).
export function decideWindowOpen(url: string): { action: "deny"; openExternal: boolean } {
  return { action: "deny", openExternal: /^https?:\/\//i.test(url) };
}
