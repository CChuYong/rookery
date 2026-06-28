// Last path segment, handling BOTH POSIX (/) and Windows (\) separators. Display names (repo/session/terminal
// titles, file names) must be just the leaf even when a path originates from a Windows daemon (C:\a\b\c → "c").
// On POSIX this is identical to split("/").pop() since "\" never appears.
export function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}
