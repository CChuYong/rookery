// GitHub issue/PR URL → title+body (gh CLI). best-effort: returns null on a bad URL or gh failure.
export type Exec = (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<string>;

export type SourceProviderId = "github" | "linear";

export interface SourceItem {
  provider: SourceProviderId;
  id: string;          // internal identifier (github number / linear id)
  identifier: string;  // for display "#12" | "ABC-123"
  title: string;
  url: string;
  body: string;
  state?: string;
}

export async function fetchGitHubItem(url: string, exec: Exec): Promise<{ title: string; body: string } | null> {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)/);
  if (!m) return null;
  const [, owner, repo, kindRaw, num] = m;
  const kind = kindRaw === "pull" ? "pr" : "issue";
  try {
    const out = await exec("gh", [kind, "view", num!, "-R", `${owner}/${repo}`, "--json", "title,body"]);
    const parsed = JSON.parse(out) as { title?: unknown; body?: unknown };
    return { title: String(parsed.title ?? ""), body: String(parsed.body ?? "") };
  } catch {
    return null; // gh not installed/not authenticated/network failure, etc. → caller handles gracefully
  }
}

// gh {issue|pr} list of one kind (owner/repo inferred automatically from cwd=repoPath). Returns [] on failure.
async function ghList(kind: "issue" | "pr", repoPath: string, query: string, exec: Exec): Promise<SourceItem[]> {
  const args = [kind, "list", "--json", "number,title,url,body,state", "--limit", "20"];
  const q = query.trim();
  if (q) args.push("--search", q);
  try {
    const out = await exec("gh", args, { cwd: repoPath });
    const rows = JSON.parse(out) as Array<{ number?: number; title?: string; url?: string; body?: string; state?: string }>;
    return rows.map((r) => ({
      provider: "github" as const,
      id: String(r.number ?? ""),
      identifier: `#${r.number ?? ""}`,
      title: String(r.title ?? ""),
      url: String(r.url ?? ""),
      body: String(r.body ?? ""),
      state: r.state ? String(r.state).toLowerCase() : undefined,
    }));
  } catch {
    return [];
  }
}

// Searches only issues in the selected repo (issues only). Returns [] on failure.
export function searchGitHubIssues(repoPath: string, query: string, exec: Exec): Promise<SourceItem[]> {
  return ghList("issue", repoPath, query, exec);
}

// Searches issues + PRs together and merges them in descending number order (most recent first), up to 20. On GitHub, issues/PRs share the number space, so they can be distinguished by #NN.
export async function searchGitHubItems(repoPath: string, query: string, exec: Exec): Promise<SourceItem[]> {
  const [issues, prs] = await Promise.all([
    ghList("issue", repoPath, query, exec),
    ghList("pr", repoPath, query, exec),
  ]);
  return [...issues, ...prs].sort((a, b) => Number(b.id) - Number(a.id)).slice(0, 20);
}

// gh auth status. If logged in, available:true (+ account if possible), otherwise false.
export async function githubAuthStatus(exec: Exec): Promise<{ available: boolean; user?: string }> {
  try {
    const out = await exec("gh", ["auth", "status"]);
    const m = out.match(/(?:account|as) (\S+)/);
    return { available: true, user: m?.[1] };
  } catch {
    return { available: false };
  }
}
