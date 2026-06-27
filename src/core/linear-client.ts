import type { SourceItem } from "./source-intake.js";

export interface LinearPort {
  searchIssues(query: string): Promise<SourceItem[]>;
  validate(): Promise<{ ok: boolean; user?: string }>;
}

const LINEAR_URL = "https://api.linear.app/graphql";
const NODE_FIELDS = "id identifier title url description state{ name }";
const SEARCH_QUERY = `query($term:String!){ searchIssues(term:$term, first:20){ nodes{ ${NODE_FIELDS} } } }`;
const RECENT_QUERY = `query{ issues(first:20, orderBy:updatedAt){ nodes{ ${NODE_FIELDS} } } }`;
const VIEWER_QUERY = `query{ viewer{ name } }`;

interface IssueNode { id?: string; identifier?: string; title?: string; url?: string; description?: string; state?: { name?: string } }

export class RealLinearClient implements LinearPort {
  constructor(
    private readonly apiKey: () => string | undefined,
    private readonly fetchFn: typeof fetch,
  ) {}

  private async gql(body: object): Promise<unknown> {
    const key = this.apiKey();
    if (!key) return null;
    const res = await this.fetchFn(LINEAR_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: key },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  }

  async searchIssues(query: string): Promise<SourceItem[]> {
    const q = query.trim();
    try {
      const json = (await this.gql(q ? { query: SEARCH_QUERY, variables: { term: q } } : { query: RECENT_QUERY })) as
        | { data?: { searchIssues?: { nodes?: IssueNode[] }; issues?: { nodes?: IssueNode[] } } }
        | null;
      const nodes = json?.data?.searchIssues?.nodes ?? json?.data?.issues?.nodes ?? [];
      return nodes.map((n) => ({
        provider: "linear" as const,
        id: String(n.id ?? ""),
        identifier: String(n.identifier ?? ""),
        title: String(n.title ?? ""),
        url: String(n.url ?? ""),
        body: String(n.description ?? ""),
        state: n.state?.name,
      }));
    } catch {
      return [];
    }
  }

  async validate(): Promise<{ ok: boolean; user?: string }> {
    try {
      const json = (await this.gql({ query: VIEWER_QUERY })) as { data?: { viewer?: { name?: string } } } | null;
      const name = json?.data?.viewer?.name;
      return name ? { ok: true, user: String(name) } : { ok: false };
    } catch {
      return { ok: false };
    }
  }
}
