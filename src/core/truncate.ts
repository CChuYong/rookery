// Truncate a string to a UTF-8 "byte" budget. char (UTF-16 code unit) based truncation, with Korean/emoji,
// overshoots the byte limit by 3~4x and defeats the byte limits of Slack/WS/DB (the root of silent truncation/loss).
// for..of iterates by code point, so it never splits surrogate pairs / multi-byte characters.
export function truncateBytes(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  const marker = "\n…(truncated)";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const withMarker = maxBytes > markerBytes;
  const budget = withMarker ? maxBytes - markerBytes : maxBytes;
  let bytes = 0;
  let out = "";
  for (const ch of s) {
    const b = Buffer.byteLength(ch, "utf8");
    if (bytes + b > budget) break;
    bytes += b;
    out += ch;
  }
  return withMarker ? out + marker : out;
}
