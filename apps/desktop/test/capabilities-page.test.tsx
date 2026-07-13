import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CapabilitiesPage } from "../src/renderer/components/CapabilitiesPage.js";
import type { CapabilitySnapshot, CapabilityTarget } from "@daemon/core/capabilities/types.js";

const target: CapabilityTarget = { kind: "session", id: "s1" };
const snapshot: CapabilitySnapshot = {
  target: { ...target, label: "Main", provider: "codex", cwd: "/repo" },
  generatedAt: "2026-07-13T12:00:00.000Z",
  entries: [
    { id: "skill", kind: "skill", name: "release", description: "Ship safely", detail: "/repo/SKILL.md", provider: "codex", source: "Codex skills/list", scope: "repo", state: "applied", evidence: "runtime" },
    { id: "mcp", kind: "mcp", name: "notion", description: "MCP server", detail: "Not logged in", provider: "codex", source: "Codex mcpServerStatus/list", scope: "session", state: "unavailable", evidence: "runtime" },
    { id: "hook", kind: "hook", name: "guard", provider: "codex", source: "Codex hooks/list", scope: "repo", state: "blocked", evidence: "runtime" },
    { id: "command", kind: "command", name: "/btw", provider: "rookery", source: "Rookery desktop", scope: "builtin", state: "applied", evidence: "declared" },
  ],
  diagnostics: [{ id: "apps", source: "Codex app/list", severity: "warning", message: "method not found" }],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("CapabilitiesPage", () => {
  it("loads and renders authoritative target metadata, summaries, evidence, and diagnostics", async () => {
    const loadSnapshot = vi.fn(async () => snapshot);
    render(<CapabilitiesPage target={target} loadSnapshot={loadSnapshot} onClose={() => {}} />);

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
    expect(within(screen.getByTestId("capability-summary")).getByText("2")).toBeInTheDocument();
  });

  it("filters entries by the five capability categories", async () => {
    render(<CapabilitiesPage target={target} loadSnapshot={async () => snapshot} onClose={() => {}} />);
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
    render(<CapabilitiesPage target={null} loadSnapshot={loadSnapshot} onClose={() => {}} />);
    expect(screen.getByText("먼저 세션이나 워커를 선택하세요.")).toBeInTheDocument();
    expect(loadSnapshot).not.toHaveBeenCalled();
  });

  it("shows request errors and retries", async () => {
    const loadSnapshot = vi.fn()
      .mockRejectedValueOnce(new Error("daemon unavailable"))
      .mockResolvedValueOnce(snapshot);
    render(<CapabilitiesPage target={target} loadSnapshot={loadSnapshot} onClose={() => {}} />);

    expect(await screen.findByText("daemon unavailable")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(await screen.findByText("release")).toBeInTheDocument();
    expect(loadSnapshot).toHaveBeenCalledTimes(2);
  });

  it("refreshes on demand", async () => {
    const loadSnapshot = vi.fn(async () => snapshot);
    render(<CapabilitiesPage target={target} loadSnapshot={loadSnapshot} onClose={() => {}} />);
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
    const { rerender } = render(<CapabilitiesPage target={target} loadSnapshot={loadSnapshot} onClose={() => {}} />);

    rerender(<CapabilitiesPage target={workerTarget} loadSnapshot={loadSnapshot} onClose={() => {}} />);
    second.resolve(workerSnapshot);
    expect(await screen.findByText("worker-only")).toBeInTheDocument();
    first.resolve(snapshot);
    await Promise.resolve();
    expect(screen.queryByText("release")).toBeNull();
    expect(screen.getByText("Worker 2")).toBeInTheDocument();
  });

  it("shows an explicit filtered-empty state and exposes no mutation controls", async () => {
    render(<CapabilitiesPage target={target} loadSnapshot={async () => ({ ...snapshot, entries: [], diagnostics: [] })} onClose={() => {}} />);
    expect(await screen.findByText("이 범주에 표시할 capability가 없어요.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /설치|활성화|편집/ })).toBeNull();
    expect(screen.getByText("유효 상태")).toBeInTheDocument();
  });
});
