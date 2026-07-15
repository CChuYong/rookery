import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CapabilityLibraryEntry, CapabilityLibrarySnapshot } from "@daemon/core/capabilities/types.js";
import { CapabilityLibraryTab } from "../src/renderer/components/capabilities/CapabilityLibraryTab.js";
import type { CapabilityCenterApi } from "../src/renderer/components/capabilities/types.js";

const pack: CapabilityLibraryEntry = {
  instanceId: "pack-1",
  sourceKind: "local-directory",
  sourcePath: "/packs/team",
  ownerRepoId: null,
  manifest: {
    schemaVersion: 1,
    id: "team-pack",
    displayName: "Team Pack",
    version: "1.2.0",
    description: "Team behavior",
    instructions: [{ id: "rules", path: "instructions/rules.md" }],
    skills: [{ id: "review", path: "skills/review" }],
    mcpServers: [
      { id: "issues", transport: "stdio", command: "issue-server", args: ["--safe"], enabledTools: ["get_issue"], env: { LOG_LEVEL: "info" }, secretEnv: { TOKEN: { source: "rookery-secret", key: "issue-token" } } },
      { id: "docs", transport: "streamable-http", url: "https://example.test/mcp", disabledTools: ["write"], headers: { "X-Mode": "read" } },
    ],
  },
  digest: "a".repeat(64),
  status: "untrusted",
  errors: [],
  files: [
    { path: "capability.json", mode: 0o644, size: 200, executable: false, sha256: "b".repeat(64) },
    { path: "bin/helper", mode: 0o755, size: 42, executable: true, sha256: "c".repeat(64) },
  ],
  changes: [{ path: "instructions/rules.md", kind: "modified" }],
  secrets: [{ key: "issue-token", configured: false }],
  createdAt: "2026-07-13T00:00:00.000Z",
  updatedAt: "2026-07-13T00:00:00.000Z",
};

const library: CapabilityLibrarySnapshot = { generation: 1, packs: [pack], bindings: [], diagnostics: [] };

function api(overrides: Partial<CapabilityCenterApi> = {}): CapabilityCenterApi {
  return {
    loadSnapshot: async () => { throw new Error("unused"); },
    loadLibrary: async () => library,
    createMcpPack: async () => { throw new Error("unused"); },
    addPack: async () => pack,
    removePack: async () => {},
    setTrust: async (_id, _digest, trusted) => ({ ...pack, status: trusted ? "trusted" : "untrusted" }),
    setSecret: async (_id, key) => ({ key, configured: true }),
    deleteSecret: async (_id, key) => ({ key, configured: false }),
    refresh: async () => library,
    reloadWorker: async (workerId) => ({ workerId, mode: "reloading" }),
    setBinding: async () => { throw new Error("unused"); },
    deleteBinding: async () => {},
    ...overrides,
  };
}

describe("CapabilityLibraryTab", () => {
  it("renders loading, empty, failure, and retry states", async () => {
    let resolve!: (snapshot: CapabilityLibrarySnapshot) => void;
    const pending = new Promise<CapabilityLibrarySnapshot>((done) => { resolve = done; });
    const loadLibrary = vi.fn().mockReturnValueOnce(pending).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ generation: 0, packs: [], bindings: [], diagnostics: [] });
    const subject = api({ loadLibrary });
    const { rerender } = render(<CapabilityLibraryTab api={subject} generation={0} repos={[]} pickDirectory={async () => null} />);
    expect(screen.getByText("불러오는 중…")).toBeInTheDocument();
    resolve({ generation: 0, packs: [], bindings: [], diagnostics: [] });
    expect(await screen.findByText("아직 등록된 capability pack이 없어요.")).toBeInTheDocument();

    rerender(<CapabilityLibraryTab api={subject} generation={1} repos={[]} pickDirectory={async () => null} />);
    expect(await screen.findByText("offline")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(await screen.findByText("아직 등록된 capability pack이 없어요.")).toBeInTheDocument();
  });

  it("requires review before trust and shows safe pack, file, MCP, and compatibility details", async () => {
    const setTrust = vi.fn(async () => ({ ...pack, status: "trusted" as const }));
    render(<CapabilityLibraryTab api={api({ setTrust })} generation={0} repos={[]} pickDirectory={async () => null} />);
    const card = await screen.findByTestId("capability-pack-pack-1");
    expect(within(card).getByText("Team Pack")).toBeInTheDocument();
    expect(within(card).getByText("Claude · Codex")).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "이 digest 신뢰" })).toBeDisabled();

    fireEvent.click(within(card).getByRole("button", { name: "검토 펼치기" }));
    expect(within(card).getByText("bin/helper")).toBeInTheDocument();
    expect(within(card).getByText("실행 가능")).toBeInTheDocument();
    expect(within(card).getByText("modified · instructions/rules.md")).toBeInTheDocument();
    expect(within(card).getByText("issue-server --safe")).toBeInTheDocument();
    expect(within(card).getByText("https://example.test/mcp")).toBeInTheDocument();
    expect(within(card).getByText(/LOG_LEVEL/)).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "이 digest 신뢰" }));
    await waitFor(() => expect(setTrust).toHaveBeenCalledWith("pack-1", "a".repeat(64), true));
  });

  it("keeps secret values write-only and resets the password input after save", async () => {
    const configured = { ...pack, secrets: [{ key: "issue-token", configured: true }] };
    const loadLibrary = vi.fn().mockResolvedValueOnce(library).mockResolvedValue({ generation: 2, packs: [configured], bindings: [], diagnostics: [] });
    const setSecret = vi.fn(async (_id: string, key: string) => ({ key, configured: true }));
    render(<CapabilityLibraryTab api={api({ loadLibrary, setSecret })} generation={0} repos={[]} pickDirectory={async () => null} />);
    const card = await screen.findByTestId("capability-pack-pack-1");
    fireEvent.click(within(card).getByRole("button", { name: "검토 펼치기" }));
    const input = within(card).getByLabelText("issue-token 값") as HTMLInputElement;
    expect(input.value).toBe("");
    fireEvent.change(input, { target: { value: "actual-secret-value" } });
    fireEvent.click(within(card).getByRole("button", { name: "저장" }));
    await waitFor(() => expect(setSecret).toHaveBeenCalledWith("pack-1", "issue-token", "actual-secret-value"));
    await waitFor(() => expect((within(card).getByLabelText("issue-token 값") as HTMLInputElement).value).toBe(""));
    expect(document.body.textContent).not.toContain("actual-secret-value");
  });

  it("adds, refreshes, and confirms removal", async () => {
    const addPack = vi.fn(async () => pack);
    const refresh = vi.fn(async () => library);
    const removePack = vi.fn(async () => {});
    const subject = api({ addPack, refresh, removePack });
    render(<CapabilityLibraryTab api={subject} generation={0} repos={[]} pickDirectory={async () => "/picked/pack"} />);
    await screen.findByText("Team Pack");
    fireEvent.click(screen.getByRole("button", { name: "디렉터리 추가" }));
    await waitFor(() => expect(addPack).toHaveBeenCalledWith("/picked/pack"));
    const card = screen.getByTestId("capability-pack-pack-1");
    fireEvent.click(within(card).getByRole("button", { name: "새로고침" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledWith("pack-1"));
    fireEvent.click(within(card).getByRole("button", { name: "삭제" }));
    expect(removePack).not.toHaveBeenCalled();
    fireEvent.click(within(card).getByRole("button", { name: "Pack 제거" }));
    await waitFor(() => expect(removePack).toHaveBeenCalledWith("pack-1"));
  });

  it("labels repo-owned packs, renders discovery diagnostics, and leaves removal to the repo index", async () => {
    const shared: CapabilityLibraryEntry = {
      ...pack,
      instanceId: "shared-pack",
      sourceKind: "repo-shared",
      ownerRepoId: "repo-1",
      sourcePath: "/repo/.rookery/capabilities/team",
    };
    const sharedLibrary: CapabilityLibrarySnapshot = {
      generation: 2,
      packs: [shared],
      bindings: [],
      diagnostics: [{ id: "repo-index", source: "repo:app/.rookery/capabilities.json", severity: "error", message: "invalid sibling pack" }],
    };
    render(<CapabilityLibraryTab api={api({ loadLibrary: async () => sharedLibrary })} generation={0} repos={[]} pickDirectory={async () => null} />);

    const card = await screen.findByTestId("capability-pack-shared-pack");
    expect(within(card).getByText("레포 공유 · repo-1")).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "삭제" })).toBeNull();
    expect(screen.getByTestId("capability-library-diagnostics")).toHaveTextContent("invalid sibling pack");
  });

  it("creates a generated MCP pack for an authoritative repo and highlights the review handoff", async () => {
    const generated: CapabilityLibraryEntry = {
      ...pack,
      instanceId: "generated-pack",
      sourceKind: "rookery-generated",
      sourcePath: "/rookery/capability-packs/repo-tools-one",
      manifest: {
        schemaVersion: 1,
        id: "repo-tools",
        displayName: "Repo Tools",
        version: "1.0.0",
        description: "",
        mcpServers: [{ id: "docs", transport: "streamable-http", url: "https://example.test/mcp" }],
      },
      status: "untrusted",
      secrets: [],
    };
    const binding = {
      id: "binding-generated",
      packInstanceId: generated.instanceId,
      scopeKind: "repo-local" as const,
      scopeRef: "repo-1",
      audience: { agents: ["master" as const, "worker" as const], origins: ["ui" as const] },
      enabled: true,
      createdAt: "t",
      updatedAt: "t",
    };
    const created = { pack: generated, binding };
    const createMcpPack = vi.fn(async () => created);
    const loadLibrary = vi.fn()
      .mockResolvedValueOnce(library)
      .mockResolvedValue({ generation: 2, packs: [generated], bindings: [binding], diagnostics: [] });
    render(<CapabilityLibraryTab
      api={api({ loadLibrary, createMcpPack })}
      generation={0}
      repos={[{ id: "repo-1", label: "Rookery" }]}
      pickDirectory={async () => null}
    />);
    await screen.findByText("Team Pack");

    fireEvent.click(screen.getByRole("button", { name: "MCP pack 만들기" }));
    const dialog = screen.getByRole("dialog", { name: "MCP pack 만들기" });
    fireEvent.change(within(dialog).getByLabelText("Pack 이름"), { target: { value: "Repo Tools" } });
    fireEvent.change(within(dialog).getByLabelText("대상 레포"), { target: { value: "repo-1" } });
    const server = within(dialog).getByTestId("mcp-server-0");
    fireEvent.change(within(server).getByLabelText("서버 ID"), { target: { value: "docs" } });
    fireEvent.change(within(server).getByLabelText("HTTP URL"), { target: { value: "https://example.test/mcp" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Pack 만들기" }));

    await waitFor(() => expect(createMcpPack).toHaveBeenCalledWith(expect.objectContaining({ repoId: "repo-1" })));
    expect(await screen.findByText("MCP pack과 레포 연결을 저장했어요.")).toBeInTheDocument();
    expect(screen.getByText(/Rookery의 Master\/Worker 대상과 secret 설정/)).toBeInTheDocument();
    const generatedCard = await screen.findByTestId("capability-pack-generated-pack");
    expect(generatedCard.className).toContain("ring-pr/15");
    expect(within(generatedCard).getByText("검토 필요")).toBeInTheDocument();
  });

  it("disables MCP pack creation until a repository is registered", async () => {
    render(<CapabilityLibraryTab api={api()} generation={0} repos={[]} pickDirectory={async () => null} />);
    await screen.findByText("Team Pack");
    expect(screen.getByRole("button", { name: "MCP pack 만들기" })).toBeDisabled();
    expect(screen.getByText(/먼저 왼쪽 레포 목록에 대상 레포를 등록/)).toBeInTheDocument();
  });
});
