import { describe, it, expect, vi } from "vitest";
import { RealLinearClient } from "../../src/core/linear-client.js";

const okJson = (data: unknown) => ({ ok: true, json: async () => ({ data }) }) as unknown as Response;

describe("RealLinearClient", () => {
  it("returns [] without an api key (no fetch)", async () => {
    const fetchFn = vi.fn();
    const c = new RealLinearClient(() => undefined, fetchFn as unknown as typeof fetch);
    expect(await c.searchIssues("x")).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("searches via searchIssues with auth header and maps nodes", async () => {
    const fetchFn = vi.fn(async () => okJson({ searchIssues: { nodes: [
      { id: "uuid1", identifier: "ABC-7", title: "Ship it", url: "https://linear.app/x/issue/ABC-7", description: "do the thing", state: { name: "In Progress" } },
    ] } }));
    const c = new RealLinearClient(() => "lin_key", fetchFn as unknown as typeof fetch);
    const items = await c.searchIssues("ship");
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://api.linear.app/graphql");
    expect((init as RequestInit).headers).toMatchObject({ authorization: "lin_key" });
    expect(String((init as RequestInit).body)).toContain("searchIssues");
    expect(items).toEqual([{ provider: "linear", id: "uuid1", identifier: "ABC-7", title: "Ship it", url: "https://linear.app/x/issue/ABC-7", body: "do the thing", state: "In Progress" }]);
  });

  it("uses issues(orderBy) for an empty query", async () => {
    const fetchFn = vi.fn(async () => okJson({ issues: { nodes: [] } }));
    const c = new RealLinearClient(() => "k", fetchFn as unknown as typeof fetch);
    await c.searchIssues("   ");
    expect(String((fetchFn.mock.calls[0]![1] as RequestInit).body)).toContain("issues(first:20");
  });

  it("validate returns user name from viewer", async () => {
    const fetchFn = vi.fn(async () => okJson({ viewer: { name: "CChuYonng" } }));
    const c = new RealLinearClient(() => "k", fetchFn as unknown as typeof fetch);
    expect(await c.validate()).toEqual({ ok: true, user: "CChuYonng" });
  });

  it("validate ok:false on non-ok response", async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, json: async () => ({}) }) as unknown as Response);
    const c = new RealLinearClient(() => "k", fetchFn as unknown as typeof fetch);
    expect(await c.validate()).toEqual({ ok: false });
  });
});
