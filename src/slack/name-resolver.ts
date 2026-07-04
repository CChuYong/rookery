// Resolve Slack channel/user IDs (as stored in automation trigger.channels/fromUsers) to human-readable
// names via the connected bolt WebClient (conversations.info / users.info). Best-effort: any lookup failure
// (revoked scope, deleted channel, rate limit, ...) simply omits that id from the result — the caller/renderer
// then falls back to showing the raw id, which is the pre-existing behavior (audit #51 fallback, no regression).
export interface SlackRefResolver {
  resolve(channels: string[], users: string[]): Promise<{ channels: Record<string, string>; users: Record<string, string> }>;
}

// Minimal shape of the bolt WebClient methods we call — kept narrow so tests can fake it without a real bolt App.
export interface SlackInfoClient {
  conversations: { info(a: { channel: string }): Promise<{ channel?: { name?: string } }> };
  users: { info(a: { user: string }): Promise<{ user?: { name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } } }> };
}

// One resolver (and its cache) is created per Slack connection (see app.ts's startSlack) — channel/user names
// rarely change and ids are stable, so caching for the lifetime of a single connection is safe; a reconnect
// naturally starts a fresh cache since a new resolver is built each time.
export function makeSlackRefResolver(client: SlackInfoClient): SlackRefResolver {
  const channelCache = new Map<string, string>();
  const userCache = new Map<string, string>();

  async function fillChannel(id: string): Promise<void> {
    if (channelCache.has(id)) return;
    try {
      const res = await client.conversations.info({ channel: id });
      const name = res.channel?.name;
      if (name) channelCache.set(id, name);
    } catch {
      /* best-effort — leave unresolved, caller falls back to the raw id */
    }
  }

  async function fillUser(id: string): Promise<void> {
    if (userCache.has(id)) return;
    try {
      const res = await client.users.info({ user: id });
      const name = res.user?.profile?.display_name || res.user?.profile?.real_name || res.user?.real_name || res.user?.name;
      if (name) userCache.set(id, name);
    } catch {
      /* best-effort — leave unresolved, caller falls back to the raw id */
    }
  }

  return {
    async resolve(channels, users) {
      await Promise.all([...channels.map(fillChannel), ...users.map(fillUser)]);
      const outChannels: Record<string, string> = {};
      for (const id of channels) { const n = channelCache.get(id); if (n) outChannels[id] = n; }
      const outUsers: Record<string, string> = {};
      for (const id of users) { const n = userCache.get(id); if (n) outUsers[id] = n; }
      return { channels: outChannels, users: outUsers };
    },
  };
}
