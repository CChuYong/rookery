export type PlanChunk =
  | { type: "markdown_text"; text: string }
  | { type: "task_update"; id: string; title: string; status: "in_progress" | "complete" | "error"; details?: string }
  | { type: "plan_update"; title: string };

export type AppendPayload = { markdown_text: string } | { chunks: PlanChunk[] };

export interface ChatStreamerLike {
  append(payload: AppendPayload): Promise<unknown>;
  stop(opts?: { blocks?: unknown[] }): Promise<unknown>;
}

export interface ChatStreamArgs {
  channel: string;
  thread_ts: string;
  buffer_size?: number;
  task_display_mode?: string;
  recipient_user_id?: string;
  recipient_team_id?: string;
}

export interface SlackClient {
  chatStream(args: ChatStreamArgs): ChatStreamerLike;
  chat: {
    // thread_ts optional → omit it to post a top-level (root) message; the returned ts threads replies + builds a permalink.
    // text is the fallback/notification; blocks (optional) carry rich layout (e.g. the worker-relay root card).
    postMessage(args: { channel: string; thread_ts?: string; text: string; blocks?: unknown[] }): Promise<{ ts?: string }>;
    getPermalink(args: { channel: string; message_ts: string }): Promise<{ permalink?: string }>;
  };
}

export interface ThreadTarget {
  channel: string;
  threadTs: string;
  team: string;
  userId?: string;
}

// A single file attached to a Slack message (normalized). urlPrivateDownload is downloaded with the Bearer bot token (files:read).
export interface SlackFile {
  id: string;
  name?: string;
  mimetype?: string;
  urlPrivateDownload?: string; // url_private_download (falls back to url_private)
}
