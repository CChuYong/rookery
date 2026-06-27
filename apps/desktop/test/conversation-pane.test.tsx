import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { useStore } from "../src/renderer/store/store.js";
import { ConversationPane } from "../src/renderer/components/ConversationPane.js";

// Shared master/worker composer busy rule: running (authoritative) ‖ pending (optimistic) → stop button.
// Since both go through the same component, only one side can't break in isolation — lock it with both cases.
function reset(): void {
  useStore.setState({ logsBySession: {}, workerLogs: {}, fleet: {}, running: {}, pendingBySession: {}, pendingByWorker: {} } as never);
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
