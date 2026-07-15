import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CapabilityBinding, CapabilityLibraryEntry, CapabilityLibrarySnapshot } from "@daemon/core/capabilities/types.js";
import { CapabilityAssignmentsTab } from "../src/renderer/components/capabilities/CapabilityAssignmentsTab.js";
import type { CapabilityCenterApi, CapabilityTargetOptions } from "../src/renderer/components/capabilities/types.js";

const pack: CapabilityLibraryEntry = {
  instanceId: "pack-1", sourceKind: "local-directory", sourcePath: "/pack", ownerRepoId: null,
  manifest: { schemaVersion: 1, id: "team", displayName: "Team Pack", version: "1", description: "Team" },
  digest: "a".repeat(64), status: "trusted", errors: [], files: [], changes: [], secrets: [], createdAt: "t", updatedAt: "t",
};
const binding: CapabilityBinding = {
  id: "binding-1", packInstanceId: "pack-1", scopeKind: "session", scopeRef: "session-1",
  audience: { agents: ["master"], origins: ["ui"] }, enabled: true, createdAt: "t", updatedAt: "t",
};
const targets: CapabilityTargetOptions = {
  repos: [{ id: "repo-1", label: "App Repo" }],
  sessions: [{ id: "session-1", label: "Main Session" }],
  workers: [{ id: "worker-1", label: "Worker One" }],
};
function snapshot(bindings: CapabilityBinding[] = []): CapabilityLibrarySnapshot { return { generation: 1, packs: [pack], bindings, diagnostics: [] }; }
function api(overrides: Partial<CapabilityCenterApi> = {}): CapabilityCenterApi {
  return {
    loadSnapshot: async () => { throw new Error("unused"); }, loadLibrary: async () => snapshot(),
    createMcp: async () => { throw new Error("unused"); },
    createSkill: async () => { throw new Error("unused"); },
    createMcpPack: async () => { throw new Error("unused"); },
    addPack: async () => pack, removePack: async () => {}, setTrust: async () => pack,
    setSecret: async (_id, key) => ({ key, configured: true }), deleteSecret: async (_id, key) => ({ key, configured: false }),
    refresh: async () => snapshot(), reloadWorker: async (workerId) => ({ workerId, mode: "reloading" }),
    setBinding: async (id, input) => ({ id, ...input, createdAt: "t", updatedAt: "t" }), deleteBinding: async () => {},
    quickSetBinding: async () => { throw new Error("unused"); },
    ...overrides,
  };
}

describe("CapabilityAssignmentsTab", () => {
  it("starts with the canonical master/worker/UI audience and saves authoritative repo ids", async () => {
    const setBinding = vi.fn(async (id, input) => ({ id, ...input, createdAt: "t", updatedAt: "t" }));
    render(<CapabilityAssignmentsTab api={api({ setBinding })} generation={0} targets={targets} />);
    await screen.findByText("새 할당");
    expect(screen.getByLabelText("마스터")).toBeChecked();
    expect(screen.getByLabelText("워커")).toBeChecked();
    expect(screen.getByLabelText("Side")).not.toBeChecked();
    expect(screen.getByLabelText("UI")).toBeChecked();

    fireEvent.change(screen.getByLabelText("범위"), { target: { value: "repo-local" } });
    fireEvent.change(screen.getByLabelText("범위 대상"), { target: { value: "repo-1" } });
    fireEvent.click(screen.getByLabelText("Side"));
    fireEvent.click(screen.getByLabelText("Slack"));
    fireEvent.click(screen.getByLabelText("자동화"));
    fireEvent.click(screen.getByLabelText("외부"));
    fireEvent.click(screen.getByRole("button", { name: "할당 만들기" }));
    await waitFor(() => expect(setBinding).toHaveBeenCalled());
    expect(setBinding.mock.calls[0]?.[1]).toEqual({
      packInstanceId: "pack-1", scopeKind: "repo-local", scopeRef: "repo-1",
      audience: { agents: ["master", "worker", "side"], origins: ["ui", "slack", "automation", "external"] }, enabled: true,
    });
  });

  it("validates non-empty agent and origin products", async () => {
    const setBinding = vi.fn();
    render(<CapabilityAssignmentsTab api={api({ setBinding })} generation={0} targets={targets} />);
    await screen.findByText("새 할당");
    fireEvent.click(screen.getByLabelText("마스터"));
    fireEvent.click(screen.getByLabelText("워커"));
    fireEvent.click(screen.getByRole("button", { name: "할당 만들기" }));
    expect(screen.getByText("Agent를 하나 이상 선택하세요.")).toBeInTheDocument();
    expect(setBinding).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("마스터"));
    fireEvent.click(screen.getByLabelText("UI"));
    fireEvent.click(screen.getByRole("button", { name: "할당 만들기" }));
    expect(screen.getByText("요청 출처를 하나 이상 선택하세요.")).toBeInTheDocument();
  });

  it("edits an assignment into an explicit tombstone and displays inheritance", async () => {
    const loadLibrary = vi.fn().mockResolvedValue(snapshot([binding]));
    const setBinding = vi.fn(async (id, input) => ({ id, ...input, createdAt: "t", updatedAt: "t" }));
    render(<CapabilityAssignmentsTab api={api({ loadLibrary, setBinding })} generation={0} targets={targets} />);
    const card = await screen.findByTestId("capability-binding-binding-1");
    expect(within(card).getByText(/더 구체적인 일치 범위/)).toBeInTheDocument();
    expect(within(card).getByText(/Main Session/)).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "편집" }));
    fireEvent.click(screen.getByLabelText(/비활성 tombstone/));
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(setBinding).toHaveBeenCalledWith("binding-1", expect.objectContaining({ enabled: false, scopeKind: "session", scopeRef: "session-1" })));
  });

  it("confirms delete and surfaces server overlap errors", async () => {
    const loadLibrary = vi.fn().mockResolvedValue(snapshot([binding]));
    const deleteBinding = vi.fn(async () => {});
    const setBinding = vi.fn(async () => { throw new Error("binding audience overlaps existing row"); });
    render(<CapabilityAssignmentsTab api={api({ loadLibrary, deleteBinding, setBinding })} generation={0} targets={targets} />);
    const card = await screen.findByTestId("capability-binding-binding-1");
    fireEvent.click(within(card).getByRole("button", { name: "삭제" }));
    expect(deleteBinding).not.toHaveBeenCalled();
    fireEvent.click(within(card).getByRole("button", { name: "삭제" }));
    await waitFor(() => expect(deleteBinding).toHaveBeenCalledWith("binding-1"));

    fireEvent.click(screen.getByRole("button", { name: "할당 만들기" }));
    expect(await screen.findByText("binding audience overlaps existing row")).toBeInTheDocument();
  });

  it("restricts repo-shared assignments to the selected pack's owner repo", async () => {
    const shared: CapabilityLibraryEntry = {
      ...pack,
      instanceId: "shared-pack",
      sourceKind: "repo-shared",
      ownerRepoId: "repo-1",
      sourcePath: "/repo/.rookery/capabilities/team",
    };
    const sharedTargets: CapabilityTargetOptions = {
      ...targets,
      repos: [{ id: "repo-1", label: "App Repo" }, { id: "repo-2", label: "Other Repo" }],
    };
    render(<CapabilityAssignmentsTab api={api({ loadLibrary: async () => ({ generation: 1, packs: [shared], bindings: [], diagnostics: [] }) })} generation={0} targets={sharedTargets} />);
    await screen.findByText("새 할당");

    fireEvent.change(screen.getByLabelText("범위"), { target: { value: "repo-shared" } });
    const targetSelect = screen.getByLabelText("범위 대상");
    await waitFor(() => expect(targetSelect).toHaveValue("repo-1"));
    expect(within(targetSelect).getByRole("option", { name: "App Repo" })).toBeInTheDocument();
    expect(within(targetSelect).queryByRole("option", { name: "Other Repo" })).toBeNull();
  });
});
