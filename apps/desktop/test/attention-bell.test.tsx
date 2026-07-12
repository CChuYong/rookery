import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AttentionBell, attentionPanelPosition } from "../src/renderer/components/AttentionBell.js";
import { useStore } from "../src/renderer/store/store.js";
import { useAcksStore } from "../src/renderer/store/acks.js";
import type { FleetRow } from "../src/renderer/store/reduce.js";

const w = (id: string, status: string): FleetRow =>
  ({ id, label: `w-${id}`, repoPath: "/r", status, branch: null, model: null, permissionMode: "bypassPermissions", ticketKey: null, ticketUrl: null }) as FleetRow;

beforeEach(() => {
  localStorage.clear();
  useAcksStore.setState({ acked: [] });
  useStore.setState({
    logsBySession: {}, liveInteractionIds: new Set(), fleet: {}, automations: [],
    attention: {}, sessionAttention: {}, sessions: [], activeSessionId: null, activeWorkerId: null, overlay: null,
  } as never);
});

describe("AttentionBell", () => {
  it("opens upward when a bottom-rail trigger has no room below", () => {
    expect(attentionPanelPosition(
      { left: 14, top: 480, bottom: 508 },
      { width: 840, height: 547 },
    )).toEqual({ left: 14, bottom: 73 });
  });

  it("opens downward and clamps horizontally when room is available", () => {
    expect(attentionPanelPosition(
      { left: 820, top: 20, bottom: 48 },
      { width: 840, height: 547 },
    )).toEqual({ left: 504, top: 54 });
  });

  it("renders no badge when quiet; opens to the empty state", () => {
    render(<AttentionBell onNavigate={vi.fn()} />);
    const btn = screen.getByRole("button");
    expect(btn.textContent).toBe(""); // no badge count
    fireEvent.click(btn);
    expect(screen.getByText("지금 필요한 것이 없어요. 전부 순항 중 ✨")).toBeInTheDocument();
  });

  it("badge counts items; clicking a failure row navigates and closes", () => {
    useStore.setState({ fleet: { w1: w("w1", "error") } } as never);
    const onNavigate = vi.fn();
    render(<AttentionBell onNavigate={onNavigate} />);
    fireEvent.click(screen.getByLabelText(/어텐션 큐/));
    fireEvent.click(screen.getByText("w-w1"));
    expect(onNavigate).toHaveBeenCalledWith({ workerId: "w1" });
    expect(screen.queryByText("실패")).toBeNull(); // popover closed
  });

  it("dismissing a failure persists the ack (item gone after reopen)", () => {
    useStore.setState({ fleet: { w1: w("w1", "failed") } } as never);
    render(<AttentionBell onNavigate={vi.fn()} />);
    fireEvent.click(screen.getByLabelText(/어텐션 큐/));
    fireEvent.click(screen.getByLabelText("묵살"));
    expect(useAcksStore.getState().acked).toContain("wfail:w1:failed");
    expect(screen.getByText(/지금 필요한 것이 없어요/)).toBeInTheDocument(); // list emptied live
  });

  it("dismissing a worker-review item flips the live unread map (no persisted ack)", () => {
    useStore.setState({ fleet: { w1: w("w1", "stopped") }, attention: { w1: true } } as never);
    render(<AttentionBell onNavigate={vi.fn()} />);
    fireEvent.click(screen.getByLabelText(/어텐션 큐/));
    fireEvent.click(screen.getByLabelText("묵살"));
    expect(useStore.getState().attention.w1).toBe(false);
    expect(useAcksStore.getState().acked).toEqual([]);
  });

  it("tier-0 interaction shows the urgent section and no dismiss button", () => {
    useStore.setState({
      sessions: [{ id: "s1", label: "질문 세션" }],
      logsBySession: { s1: [{ kind: "interaction", requestId: "r1", mode: "ask", questions: [{ question: "Q?", header: "h", options: [], multiSelect: false }] }] },
      liveInteractionIds: new Set(["r1"]),
    } as never);
    render(<AttentionBell onNavigate={vi.fn()} />);
    fireEvent.click(screen.getByLabelText(/어텐션 큐/));
    expect(screen.getByText("응답 대기")).toBeInTheDocument();
    expect(screen.getByText("질문 세션")).toBeInTheDocument();
    expect(screen.queryByLabelText("묵살")).toBeNull(); // tier 0 resolves itself
  });
});
