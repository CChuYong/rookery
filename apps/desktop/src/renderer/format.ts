export function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
export function fmtDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}
export function contextPct(tokens: number, window: number): number {
  if (!window) return 0;
  // Context can never exceed 100% — safety clamp (defense in depth; prevents showing >100% even if the data is bad).
  return Math.min(100, Math.round((tokens / window) * 100));
}
export function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0.00";
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}
// Context usage tone (single threshold — used in the session header SessionMetrics). Color-blindness is covered by the text (%) channel.
export function ctxTone(pct: number): string {
  return pct >= 85 ? "text-fail" : pct >= 65 ? "text-run" : "text-fg-dim";
}
// Bytes → human-readable units. MB to 1 decimal, GB to 2 decimals (matches the abs/rm.png notation).
export function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${Math.round(n)} B`;
}
