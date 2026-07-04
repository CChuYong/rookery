import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useStore } from "../src/renderer/store/store.js";
import { ConversationPane } from "../src/renderer/components/ConversationPane.js";

// Shared master/worker composer busy rule: running (authoritative) ‖ pending (optimistic) → stop button.
// Since both go through the same component, only one side can't break in isolation — lock it with both cases.
function reset(): void {
  useStore.setState({ logsBySession: {}, workerLogs: {}, fleet: {}, running: {}, pendingBySession: {}, pendingByWorker: {}, historyLoaded: {}, historyLoadFailed: {} } as never);
}

describe("ConversationPane busy derivation (master/worker unified)", () => {
  beforeEach(reset);

  it("master: stop button shows when running[id] is true (server-authoritative)", () => {
    useStore.setState({ running: { s1: true } } as never);
    render(<ConversationPane kind="master" id="s1" onSend={() => {}} onStop={() => {}} />);
    expect(screen.getByRole("button", { name: "중단" })).toBeInTheDocument();
  });

  it("master: stop button shows from a pending message alone (optimistic, before server running)", () => {
    useStore.setState({ pendingBySession: { s1: [{ clientMsgId: "c1", text: "큐메시지" }] } } as never);
    render(<ConversationPane kind="master" id="s1" onSend={() => {}} onStop={() => {}} />);
    expect(screen.getByRole("button", { name: "중단" })).toBeInTheDocument();
    expect(screen.getByText("큐메시지")).toBeInTheDocument(); // pending bubble also renders
  });

  it("master: no stop button when idle and no pending", () => {
    render(<ConversationPane kind="master" id="s1" onSend={() => {}} onStop={() => {}} />);
    expect(screen.queryByRole("button", { name: "중단" })).toBeNull();
  });

  it("worker: stop button shows when FleetRow.status is running (same authoritative rule)", () => {
    useStore.setState({ fleet: { w1: { id: "w1", label: "", repoPath: "/r", status: "running", branch: null, model: null } } } as never);
    render(<ConversationPane kind="worker" id="w1" onSend={() => {}} onStop={() => {}} />);
    expect(screen.getByRole("button", { name: "중단" })).toBeInTheDocument();
  });

  it("worker: stop button shows from pending alone when status not running", () => {
    useStore.setState({ fleet: { w1: { id: "w1", label: "", repoPath: "/r", status: "idle", branch: null, model: null } }, pendingByWorker: { w1: [{ clientMsgId: "c2", text: "go" }] } } as never);
    render(<ConversationPane kind="worker" id="w1" onSend={() => {}} onStop={() => {}} />);
    expect(screen.getByRole("button", { name: "중단" })).toBeInTheDocument();
  });
});

// ConversationPane reads historyLoaded/historyLoadFailed itself (mirroring how it already reads items/pending/running)
// and wires retry back through onRetryHistory(kind, id) (audit #43).
describe("ConversationPane history-load state (audit #43)", () => {
  beforeEach(reset);

  it("unloaded id → MessageList shows a skeleton, not the empty hint", () => {
    const { container } = render(<ConversationPane kind="master" id="s1" onSend={() => {}} />);
    expect(container.querySelector(".sheen")).not.toBeNull();
    expect(screen.queryByText(/대화를 시작하세요/)).toBeNull();
  });

  it("historyLoadFailed → retry click calls onRetryHistory with this pane's (kind, id)", () => {
    useStore.setState({ historyLoadFailed: { w1: true } } as never);
    const onRetryHistory = vi.fn();
    render(<ConversationPane kind="worker" id="w1" onSend={() => {}} onRetryHistory={onRetryHistory} />);
    fireEvent.click(screen.getByText("대화를 불러오지 못했어요 — 다시 시도"));
    expect(onRetryHistory).toHaveBeenCalledWith("worker", "w1");
  });

  it("historyLoaded master → the master empty hint (not the worker copy)", () => {
    useStore.setState({ historyLoaded: { s1: true } } as never);
    render(<ConversationPane kind="master" id="s1" onSend={() => {}} />);
    expect(screen.getByText("메시지를 입력해 마스터와 대화를 시작하세요.")).toBeInTheDocument();
  });

  it("historyLoaded worker → the worker empty hint, which does not say 'master'", () => {
    useStore.setState({ historyLoaded: { w1: true } } as never);
    render(<ConversationPane kind="worker" id="w1" onSend={() => {}} />);
    const hint = screen.getByText("이 워커와의 대화가 아직 없어요.");
    expect(hint.textContent).not.toContain("마스터");
  });
});
