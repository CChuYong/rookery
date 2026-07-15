import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RepositorySettingsPage } from "../src/renderer/components/repository-settings/RepositorySettingsPage.js";
import type { CapabilityCenterApi } from "../src/renderer/components/capabilities/types.js";

function api(): CapabilityCenterApi {
  return {
    loadSnapshot: async () => { throw new Error("unused"); },
    loadLibrary: async () => ({ generation: 0, packs: [], bindings: [], diagnostics: [] }),
    createMcp: async () => { throw new Error("unused"); },
    createSkill: async () => { throw new Error("unused"); },
    createMcpPack: async () => { throw new Error("unused"); },
    addPack: async () => { throw new Error("unused"); },
    removePack: async () => {},
    setTrust: async () => { throw new Error("unused"); },
    setSecret: async (_id, key) => ({ key, configured: true }),
    deleteSecret: async (_id, key) => ({ key, configured: false }),
    refresh: async () => ({ generation: 0, packs: [], bindings: [], diagnostics: [] }),
    reloadWorker: async (workerId) => ({ workerId, mode: "reloading" }),
    setBinding: async () => { throw new Error("unused"); },
    quickSetBinding: async () => null,
    deleteBinding: async () => {},
  };
}

describe("RepositorySettingsPage", () => {
  it("renders a repository-keyed full-page shell with only registered sections", async () => {
    const onClose = vi.fn();
    render(<RepositorySettingsPage repo={{ id: "repo-1", name: "Rookery", path: "/code/rookery" }} api={api()} generation={0} onClose={onClose} onOpenCatalog={() => {}} onOpenAdvancedAssignments={() => {}} />);
    expect(screen.getByRole("heading", { name: "Rookery" })).toBeInTheDocument();
    expect(screen.getByText("/code/rookery")).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "레포 설정 섹션" });
    expect(nav).toHaveTextContent("Capabilities");
    expect(nav).not.toHaveTextContent("Worktrees");
    expect(nav).not.toHaveTextContent("Hooks");
    expect(nav).not.toHaveTextContent("Branches");
    expect(await screen.findByText(/카탈로그가 비어 있어요/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "닫기" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("routes an empty catalog to Capability Center", async () => {
    const onOpenCatalog = vi.fn();
    render(<RepositorySettingsPage repo={{ id: "repo-1", name: "Rookery", path: "/code/rookery" }} api={api()} generation={0} onClose={() => {}} onOpenCatalog={onOpenCatalog} onOpenAdvancedAssignments={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Capability Center 열기" }));
    expect(onOpenCatalog).toHaveBeenCalledOnce();
  });
});
