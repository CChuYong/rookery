export type Entry = { name: string; isDir: boolean };
export type Row = { path: string; name: string; isDir: boolean; depth: number };

// Flattens visible rows by descending only into expanded directories. Sorting is already guaranteed by list() (here we just preserve order).
export function flatten(root: string, expanded: Set<string>, children: Map<string, Entry[]>): Row[] {
  const out: Row[] = [];
  const walk = (dir: string, depth: number): void => {
    const ents = children.get(dir);
    if (!ents) return;
    for (const e of ents) {
      const path = `${dir}/${e.name}`;
      out.push({ path, name: e.name, isDir: e.isDir, depth });
      if (e.isDir && expanded.has(path)) walk(path, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

export function parentDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? path : path.slice(0, i);
}

// Absolute paths of ancestor directories from root (inclusive) up to filePath's immediate parent.
export function ancestorDirs(filePath: string, root: string): string[] {
  const out: string[] = [];
  let cur = parentDir(filePath);
  while (cur.length >= root.length && cur.startsWith(root)) {
    out.unshift(cur);
    if (cur === root) break;
    cur = parentDir(cur);
  }
  return out;
}

// Subsequence match score (lower is better). Rewards adjacent matches (consecutive characters) the most, and on a tie prefers the match that
// starts earlier → "filetree" ranks "FileTree.tsx" (consecutive) above "file-tree.test.tsx" (broken up). Returns -1 on failure.
function subseqScore(hay: string, needle: string): number {
  let hi = 0;
  let gaps = 0;
  let first = -1;
  let prev = -1;
  for (let ni = 0; ni < needle.length; ni++) {
    const c = needle[ni];
    let found = -1;
    for (; hi < hay.length; hi++) {
      if (hay[hi] === c) { found = hi; hi++; break; }
    }
    if (found === -1) return -1;
    if (first === -1) first = found;
    else gaps += found - prev - 1; // 0 if adjacent, increases the farther apart they are
    prev = found;
  }
  return gaps * 10_000 + first; // gaps take priority, on a tie compare by start position (first)
}

export function fuzzyFilter(paths: string[], query: string, limit = 50): string[] {
  const q = query.toLowerCase();
  if (!q) return paths.slice(0, limit);
  const scored: Array<{ p: string; s: number }> = [];
  for (const p of paths) {
    const s = subseqScore(p.toLowerCase(), q);
    if (s >= 0) scored.push({ p, s });
  }
  scored.sort((a, b) => a.s - b.s || a.p.length - b.p.length);
  return scored.slice(0, limit).map((x) => x.p);
}
