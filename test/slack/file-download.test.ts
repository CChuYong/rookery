import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeFileDownloader } from "../../src/slack/file-download.js";

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "rk-slack-"));
const okFetch = (body: string) =>
  (async () => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode(body).buffer })) as never;

describe("makeFileDownloader", () => {
  it("downloads with a Bearer bot token and writes to <dir>/<id>/<name>, returning the path", async () => {
    const dir = await tmp();
    let sawUrl: string | undefined;
    let sawAuth: string | undefined;
    const fetchImpl = (async (url: string, init: { headers: Record<string, string> }) => {
      sawUrl = url;
      sawAuth = init.headers.Authorization;
      return { ok: true, arrayBuffer: async () => new TextEncoder().encode("log contents").buffer };
    }) as never;
    const dl = makeFileDownloader({ token: "xoxb-1", dir, fetchImpl });
    const p = await dl({ id: "F1", name: "app.log", urlPrivateDownload: "https://files.slack.com/F1/app.log" });
    expect(p).toBe(path.join(dir, "F1", "app.log"));
    expect(sawUrl).toContain("files.slack.com");
    expect(sawAuth).toBe("Bearer xoxb-1"); // files:read auth
    expect(await fs.readFile(p!, "utf8")).toBe("log contents");
  });

  it("returns null without a token, without a url, or on a non-ok response", async () => {
    const dir = await tmp();
    expect(await makeFileDownloader({ token: undefined, dir })({ id: "F", urlPrivateDownload: "u" })).toBeNull();
    expect(await makeFileDownloader({ token: "t", dir })({ id: "F" })).toBeNull(); // no url
    const failing = makeFileDownloader({ token: "t", dir, fetchImpl: (async () => ({ ok: false, arrayBuffer: async () => new ArrayBuffer(0) })) as never });
    expect(await failing({ id: "F", name: "x", urlPrivateDownload: "u" })).toBeNull();
  });

  it("sanitizes the file name (no path traversal out of <dir>/<id>)", async () => {
    const dir = await tmp();
    const p = await makeFileDownloader({ token: "t", dir, fetchImpl: okFetch("x") })({ id: "F2", name: "../../etc/passwd", urlPrivateDownload: "u" });
    expect(p!.startsWith(path.join(dir, "F2") + path.sep)).toBe(true);
    expect(p).not.toContain("..");
  });
});
