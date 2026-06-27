import path from "node:path";
import { promises as fs } from "node:fs";
import type { SlackFile } from "./types.js";

// Download a Slack attachment locally and return its absolute path (null if none). The master receives this path via @mention and views it with Read.
export type FileDownloader = (file: SlackFile) => Promise<string | null>;

// Minimal shape of the real fetch (for test injection).
type FetchLike = (url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean; arrayBuffer: () => Promise<ArrayBuffer> }>;

// url_private(_download) can only be fetched with a Bearer bot token (files:read). Returns null if the token/URL is missing or the fetch fails (best-effort).
export function makeFileDownloader(opts: { token?: string; dir: string; fetchImpl?: FetchLike }): FileDownloader {
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  return async (file) => {
    const url = file.urlPrivateDownload;
    if (!opts.token || !url) return null;
    try {
      const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${opts.token}` } });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      // The filename is basename + safe characters only → cannot escape the directory (prevents path traversal). A per-id folder prevents collisions.
      const safe = path.basename(file.name ?? file.id).replace(/[^\w.\-]+/g, "_") || file.id;
      const fileDir = path.join(opts.dir, file.id);
      await fs.mkdir(fileDir, { recursive: true, mode: 0o700 });
      const out = path.join(fileDir, safe);
      await fs.writeFile(out, buf, { mode: 0o600 });
      return out;
    } catch {
      return null;
    }
  };
}
