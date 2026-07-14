import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CapabilitiesPage } from "../src/renderer/components/CapabilitiesPage.js";
import type { CapabilitySnapshot, CapabilityTarget } from "@daemon/core/capabilities/types.js";
import type { CapabilityCenterApi } from "../src/renderer/components/capabilities/types.js";

const target: CapabilityTarget = { kind: "session", id: "s1" };
const snapshot: CapabilitySnapshot = {
  target: { ...target, label: "Main", provider: "codex", cwd: "/repo" },
  generatedAt: "2026-07-13T12:00:00.000Z",
  entries: [
    { id: "skill", kind: "skill", name: "release", description: "Ship safely", detail: "/repo/SKILL.md", provider: "codex", source: "Codex skills/list", scope: "repo", state: "applied", evidence: "runtime" },
    { id: "mcp", kind: "mcp", name: "notion", description: "MCP server", detail: "Not logged in", provider: "codex", source: "Codex mcpServerStatus/list", scope: "session", state: "unavailable", evidence: "runtime" },
    { id: "hook", kind: "hook", name: "guard", provider: "codex", source: "Codex hooks/list", scope: "repo", state: "blocked", evidence: "runtime" },
    { id: "command", kind: "command", name: "/btw", provider: "rookery", source: "Rookery desktop", scope: "builtin", state: "applied", evidence: "declared" },
    { id: "managed-rules", kind: "instruction", name: "team-rules", provider: "rookery", source: "Team Pack", scope: "repo", state: "desired", evidence: "declared", managed: { packInstanceId: "pack-1", packId: "team-pack", bindingId: "binding-1", scopeKind: "repo-local", enabled: true } },
    { id: "managed-side-mcp", kind: "mcp", name: "side-search", provider: "rookery", source: "Team Pack", scope: "session", state: "suppressed", evidence: "declared", managed: { packInstanceId: "pack-1", packId: "team-pack", bindingId: "binding-2", scopeKind: "session", enabled: false } },
  ],
  desiredRevision: "1234567890abcdef",
  desiredBlocked: true,
  diagnostics: [{ id: "apps", source: "Codex app/list", severity: "warning", message: "method not found" }],
};

const targets = { repos: [], sessions: [], workers: [] };
function makeApi(loadSnapshot: (target: CapabilityTarget) => Promise<CapabilitySnapshot>): CapabilityCenterApi {
  return {
    loadSnapshot,
    loadLibrary: async () => ({ generation: 0, packs: [], bindings: [] }),
    addPack: async () => { throw new Error("unused"); },
    removePack: async () => {},
    setTrust: async () => { throw new Error("unused"); },
    setSecret: async (_instanceId, key) => ({ key, configured: true }),
    deleteSecret: async (_instanceId, key) => ({ key, configured: false }),
    refresh: async () => ({ generation: 0, packs: [], bindings: [] }),
    reloadWorker: async (workerId) => ({ workerId, mode: "reloading" }),
    setBinding: async () => { throw new Error("unused"); },
    deleteBinding: async () => {},
  };
}

function pageProps(api: CapabilityCenterApi, generation = 0) {
  return { api, targets, generation, pickDirectory: async () => null, onClose: () => {} };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("CapabilitiesPage", () => {
  it("loads and renders authoritative target metadata, summaries, evidence, and diagnostics", async () => {
    const loadSnapshot = vi.fn(async () => snapshot);
    render(<CapabilitiesPage target={target} {...pageProps(makeApi(loadSnapshot))} />);

    expect(screen.getByText("불러오는 중…")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Main")).toBeInTheDocument());
    expect(loadSnapshot).toHaveBeenCalledWith(target);
    expect(screen.getAllByText("Codex").length).toBeGreaterThan(0);
    expect(screen.getByText("/repo")).toBeInTheDocument();
    expect(screen.getByText("release")).toBeInTheDocument();
    expect(screen.getByText("Codex skills/list")).toBeInTheDocument();
    expect(screen.getAllByText("레포").length).toBeGreaterThan(0);
    expect(screen.getAllByText("런타임 확인").length).toBeGreaterThan(0);
    expect(screen.getByText("일부 항목을 확인하지 못했어요")).toBeInTheDocument();
    expect(screen.getByText("method not found")).toBeInTheDocument();
    expect(screen.getByText("team-rules")).toBeInTheDocument();
    expect(screen.getAllByText("적용 예정").length).toBeGreaterThan(0);
    expect(screen.getAllByText("억제됨").length).toBeGreaterThan(0);
    expect(screen.getByText(/원하는 리비전 1234567890ab/)).toBeInTheDocument();
    expect(within(screen.getByTestId("capability-summary")).getByText("2")).toBeInTheDocument();
  });

  it("filters entries by the five capability categories", async () => {
    render(<CapabilitiesPage target={target} {...pageProps(makeApi(async () => snapshot))} />);
    await screen.findByText("release");

    fireEvent.click(screen.getByRole("button", { name: "도구 & MCP" }));
    expect(screen.getByText("notion")).toBeInTheDocument();
    expect(screen.queryByText("release")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "훅" }));
    expect(screen.getByText("guard")).toBeInTheDocument();
    expect(screen.queryByText("notion")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "스킬 & 명령어" }));
    expect(screen.getByText("release")).toBeInTheDocument();
    expect(screen.getByText("/btw")).toBeInTheDocument();
  });

  it("shows an explicit no-target state without making a request", () => {
    const loadSnapshot = vi.fn(async () => snapshot);
    render(<CapabilitiesPage target={null} {...pageProps(makeApi(loadSnapshot))} />);
    expect(screen.getByText("먼저 세션이나 워커를 선택하세요.")).toBeInTheDocument();
    expect(loadSnapshot).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "유효 상태" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "라이브러리" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "할당" })).toBeInTheDocument();
  });

  it("shows request errors and retries", async () => {
    const loadSnapshot = vi.fn()
      .mockRejectedValueOnce(new Error("daemon unavailable"))
      .mockResolvedValueOnce(snapshot);
    render(<CapabilitiesPage target={target} {...pageProps(makeApi(loadSnapshot))} />);

    expect(await screen.findByText("daemon unavailable")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(await screen.findByText("release")).toBeInTheDocument();
    expect(loadSnapshot).toHaveBeenCalledTimes(2);
  });

  it("refreshes on demand", async () => {
    const loadSnapshot = vi.fn(async () => snapshot);
    render(<CapabilitiesPage target={target} {...pageProps(makeApi(loadSnapshot))} />);
    await screen.findByText("release");
    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    await waitFor(() => expect(loadSnapshot).toHaveBeenCalledTimes(2));
  });

  it("ignores a stale response after switching targets", async () => {
    const first = deferred<CapabilitySnapshot>();
    const second = deferred<CapabilitySnapshot>();
    const workerTarget: CapabilityTarget = { kind: "worker", id: "w2" };
    const workerSnapshot: CapabilitySnapshot = {
      ...snapshot,
      target: { ...workerTarget, label: "Worker 2", provider: "claude", cwd: "/repo/.wt/w2" },
      entries: [{ ...snapshot.entries[0]!, id: "worker-skill", name: "worker-only", provider: "claude" }],
      diagnostics: [],
    };
    const loadSnapshot = vi.fn((next: CapabilityTarget) => next.id === "s1" ? first.promise : second.promise);
    const api = makeApi(loadSnapshot);
    const { rerender } = render(<CapabilitiesPage target={target} {...pageProps(api)} />);

    rerender(<CapabilitiesPage target={workerTarget} {...pageProps(api)} />);
    second.resolve(workerSnapshot);
    expect(await screen.findByText("worker-only")).toBeInTheDocument();
    first.resolve(snapshot);
    await Promise.resolve();
    expect(screen.queryByText("release")).toBeNull();
    expect(screen.getByText("Worker 2")).toBeInTheDocument();
  });

  it("shows an explicit filtered-empty state and exposes no mutation controls", async () => {
    render(<CapabilitiesPage target={target} {...pageProps(makeApi(async () => ({ ...snapshot, entries: [], diagnostics: [] })))} />);
    expect(await screen.findByText("이 범주에 표시할 capability가 없어요.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /설치|활성화|편집/ })).toBeNull();
    expect(screen.getByText("유효 상태")).toBeInTheDocument();
  });

  it("reloads the active Effective tab when capability generation changes", async () => {
    const loadSnapshot = vi.fn(async () => snapshot);
    const api = makeApi(loadSnapshot);
    const { rerender } = render(<CapabilitiesPage target={target} {...pageProps(api, 1)} />);
    await screen.findByText("team-rules");
    rerender(<CapabilitiesPage target={target} {...pageProps(api, 2)} />);
    await waitFor(() => expect(loadSnapshot).toHaveBeenCalledTimes(2));
  });

  it("renders desired/applied drift and the pending lifecycle labels", async () => {
    const runtimeSnapshot: CapabilitySnapshot = {
      ...snapshot,
      target: { ...target, label: "Codex Main", provider: "codex", cwd: "/repo" },
      desiredRevision: "abcdef1234567890",
      appliedRevision: "0011223344556677",
      desiredBlocked: false,
      entries: [
        { ...snapshot.entries[4]!, state: "pending-next-turn" },
        { ...snapshot.entries[4]!, id: "worker-pending", name: "worker-rules", state: "pending-reload" },
      ],
      diagnostics: [],
    };
    render(<CapabilitiesPage target={target} {...pageProps(makeApi(async () => runtimeSnapshot))} />);

    await screen.findByText("Codex Main");
    expect(screen.getByText(/원하는 리비전 abcdef123456/)).toBeInTheDocument();
    expect(screen.getByText(/적용된 리비전 001122334455/)).toBeInTheDocument();
    expect(screen.getAllByText("다음 턴에 적용").length).toBeGreaterThan(0);
    expect(screen.getAllByText("재시작 필요").length).toBeGreaterThan(0);
  });

  it("offers immediate and when-idle reloads only for workers with managed runtime drift", async () => {
    const workerTarget: CapabilityTarget = { kind: "worker", id: "w1" };
    const workerSnapshot: CapabilitySnapshot = {
      ...snapshot,
      target: { ...workerTarget, label: "Worker 1", provider: "claude", cwd: "/repo/.wt/w1" },
      entries: [{ ...snapshot.entries[4]!, state: "pending-reload" }],
      diagnostics: [],
    };
    const api = makeApi(async () => workerSnapshot);
    api.reloadWorker = vi.fn(async (workerId, whenIdle) => ({ workerId, mode: whenIdle ? "scheduled" as const : "reloading" as const }));
    render(<CapabilitiesPage target={workerTarget} {...pageProps(api)} />);

    await screen.findByTestId("capability-worker-reload");
    fireEvent.click(screen.getByRole("button", { name: "대기 상태일 때" }));
    await waitFor(() => expect(api.reloadWorker).toHaveBeenCalledWith("w1", true));
    expect(await screen.findByText(/대기 상태가 되면/)).toBeInTheDocument();
  });

  it("shows worker reload failures and does not offer reload controls for a master session", async () => {
    const workerTarget: CapabilityTarget = { kind: "worker", id: "w1" };
    const workerSnapshot: CapabilitySnapshot = {
      ...snapshot,
      target: { ...workerTarget, label: "Worker 1", provider: "claude", cwd: "/repo/.wt/w1" },
      entries: [{ ...snapshot.entries[4]!, state: "error" }],
      diagnostics: [],
    };
    const api = makeApi(async () => workerSnapshot);
    api.reloadWorker = vi.fn(async () => { throw new Error("runtime replacement failed"); });
    const { rerender } = render(<CapabilitiesPage target={workerTarget} {...pageProps(api)} />);

    fireEvent.click(await screen.findByRole("button", { name: "지금 다시 불러오기" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("runtime replacement failed");

    rerender(<CapabilitiesPage target={target} {...pageProps(makeApi(async () => ({ ...workerSnapshot, target: snapshot.target })))} />);
    await screen.findByText("Main");
    expect(screen.queryByTestId("capability-worker-reload")).toBeNull();
  });
});
