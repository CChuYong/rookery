// The last segment of the path (the file name). Empty string for an empty path.
export function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}
