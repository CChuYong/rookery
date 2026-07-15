import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CapabilityBinding, CapabilityLibraryEntry, CapabilityLibrarySnapshot } from "@daemon/core/capabilities/types.js";
import { RepositoryCapabilitiesSection } from "../src/renderer/components/repository-settings/RepositoryCapabilitiesSection.js";
import type { CapabilityCenterApi } from "../src/renderer/components/capabilities/types.js";

const mcp: CapabilityLibraryEntry = {
  instanceId: "mcp-1", sourceKind: "rookery-generated", sourcePath: "/generated/mcp", ownerRepoId: null,
  manifest: { schemaVersion: 1, id: "docs", displayName: "Docs MCP", version: "1.0.0", description: "Search docs", mcpServers: [{ id: "docs", transport: "streamable-http", url: "https://example.test/mcp" }] },
  digest: "a".repeat(64), status: "trusted", errors: [], files: [], changes: [], secrets: [{ key: "docs-token", configured: false }], createdAt: "t", updatedAt: "t",
};
const skill: CapabilityLibraryEntry = {
  ...mcp, instanceId: "skill-1", sourcePath: "/generated/skill",
  manifest: { schemaVersion: 1, id: "review", displayName: "Review Skill", version: "1.0.0", description: "Review changes", skills: [{ id: "review", path: "skills/review" }] },
  status: "untrusted", secrets: [],
};
const bundle: CapabilityLibraryEntry = {
  ...mcp, instanceId: "bundle-1", sourceKind: "local-directory", sourcePath: "/packs/team",
  manifest: { schemaVersion: 1, id: "team", displayName: "Team Bundle", version: "1", description: "Team tools", skills: [{ id: "ship", path: "skills/ship" }], mcpServers: [{ id: "issues", transport: "stdio", command: "issues" }] },
  secrets: [],
};
const direct: CapabilityBinding = {
  id: "direct", packInstanceId: "mcp-1", scopeKind: "repo-local", scopeRef: "repo-1",
  audience: { agents: ["master"], origins: ["ui"] }, enabled: true, createdAt: "t", updatedAt: "t",
};
const custom: CapabilityBinding = {
  id: "custom", packInstanceId: "skill-1", scopeKind: "repo-local", scopeRef: "repo-1",
  audience: { agents: ["master"], origins: ["ui", "slack"] }, enabled: true, createdAt: "t", updatedAt: "t",
};

function snapshot(bindings: CapabilityBinding[] = [direct, custom]): CapabilityLibrarySnapshot {
  return { generation: 1, packs: [mcp, skill, bundle], bindings, diagnostics: [] };
}
function api(overrides: Partial<CapabilityCenterApi> = {}): CapabilityCenterApi {
  return {
    loadSnapshot: async () => { throw new Error("unused"); }, loadLibrary: async () => snapshot(),
    createMcp: async () => { throw new Error("unused"); }, createSkill: async () => { throw new Error("unused"); }, createMcpPack: async () => { throw new Error("unused"); },
    addPack: async () => mcp, removePack: async () => {}, setTrust: async () => mcp,
    setSecret: async (_id, key) => ({ key, configured: true }), deleteSecret: async (_id, key) => ({ key, configured: false }),
    refresh: async () => snapshot(), reloadWorker: async (workerId) => ({ workerId, mode: "reloading" }),
    setBinding: async () => { throw new Error("unused"); }, quickSetBinding: async () => null, deleteBinding: async () => {},
    ...overrides,
  };
}

describe("RepositoryCapabilitiesSection", () => {
  it("renders searchable MCP, Skill, and Bundle rows with safety status", async () => {
    render(<RepositoryCapabilitiesSection repoId="repo-1" api={api()} generation={0} onOpenCatalog={() => {}} onOpenAdvancedAssignments={() => {}} />);
    const mcpRow = await screen.findByTestId("repository-capability-mcp-1");
    expect(mcpRow).toHaveTextContent("MCP");
    expect(mcpRow).toHaveTextContent("신뢰함");
    expect(mcpRow).toHaveTextContent("필수 secret 1개");
    expect(screen.getByTestId("repository-capability-skill-1")).toHaveTextContent("스킬");
    expect(screen.getByTestId("repository-capability-bundle-1")).toHaveTextContent("번들");
    fireEvent.change(screen.getByLabelText("레포 capability 검색"), { target: { value: "Review" } });
    expect(screen.queryByTestId("repository-capability-mcp-1")).toBeNull();
    expect(screen.getByTestId("repository-capability-skill-1")).toBeInTheDocument();
  });

  it("submits an exact repo-local UI quick assignment per row", async () => {
    const quickSetBinding = vi.fn(async () => null);
    render(<RepositoryCapabilitiesSection repoId="repo-1" api={api({ quickSetBinding })} generation={0} onOpenCatalog={() => {}} onOpenAdvancedAssignments={() => {}} />);
    const row = await screen.findByTestId("repository-capability-mcp-1");
    expect(within(row).getByLabelText("Docs MCP 할당")).toHaveValue("enabled");
    expect(within(row).getByLabelText("마스터")).toBeChecked();
    expect(within(row).getByLabelText("워커")).not.toBeChecked();
    fireEvent.change(within(row).getByLabelText("Docs MCP 할당"), { target: { value: "disabled" } });
    fireEvent.click(within(row).getByLabelText("워커"));
    fireEvent.click(within(row).getByRole("button", { name: "저장" }));
    await waitFor(() => expect(quickSetBinding).toHaveBeenCalledWith({ packInstanceId: "mcp-1", scopeKind: "repo-local", scopeRef: "repo-1", mode: "disabled", agents: ["master", "worker"] }));
  });

  it("sends inherit with no agents and locks custom overlaps behind advanced assignments", async () => {
    const quickSetBinding = vi.fn(async () => null);
    const onOpenAdvancedAssignments = vi.fn();
    render(<RepositoryCapabilitiesSection repoId="repo-1" api={api({ quickSetBinding })} generation={0} onOpenCatalog={() => {}} onOpenAdvancedAssignments={onOpenAdvancedAssignments} />);
    const mcpRow = await screen.findByTestId("repository-capability-mcp-1");
    fireEvent.change(within(mcpRow).getByLabelText("Docs MCP 할당"), { target: { value: "inherit" } });
    fireEvent.click(within(mcpRow).getByRole("button", { name: "저장" }));
    await waitFor(() => expect(quickSetBinding).toHaveBeenCalledWith(expect.objectContaining({ mode: "inherit", agents: [] })));
    const customRow = screen.getByTestId("repository-capability-skill-1");
    expect(within(customRow).queryByRole("combobox")).toBeNull();
    fireEvent.click(within(customRow).getByRole("button", { name: "고급 할당" }));
    expect(onOpenAdvancedAssignments).toHaveBeenCalledOnce();
  });

  it("shows load failure and retries", async () => {
    const loadLibrary = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(snapshot());
    render(<RepositoryCapabilitiesSection repoId="repo-1" api={api({ loadLibrary })} generation={0} onOpenCatalog={() => {}} onOpenAdvancedAssignments={() => {}} />);
    expect(await screen.findByText("offline")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(await screen.findByText("Docs MCP")).toBeInTheDocument();
  });
});
