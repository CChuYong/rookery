import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { useStore } from "../src/renderer/store/store.js";
import { ConversationPane } from "../src/renderer/components/ConversationPane.js";

// Shared master/worker composer busy rule: running (authoritative) ‖ pending (optimistic) → stop button.
// Since both go through the same component, only one side can't break in isolation — lock it with both cases.
function reset(): void {
  useStore.setState({ logsBySession: {}, workerLogs: {}, fleet: {}, running: {}, pendingBySession: {}, pendingByWorker: {}, sideConversations: {}, historyLoaded: {}, historyLoadFailed: {} } as never);
}

const SIDE_COMMANDS = [
  { id: "btw", name: "btw", description: "side", argumentHint: "<질문>", action: { type: "open-panel" as const, panel: "btw" as const } },
  { id: "side", name: "side", description: "side", argumentHint: "<질문>", action: { type: "open-panel" as const, panel: "side" as const } },
];

describe("ConversationPane Side drawer", () => {
  beforeEach(reset);

  it("opens a read-only master Side drawer from the current composer draft and closes only that Side", async () => {
    const onSideStart = vi.fn(async () => "side-1");
    const onSideClose = vi.fn();
    render(<ConversationPane kind="master" id="s1" onSend={() => {}} onSideStart={onSideStart} onSideClose={onSideClose} />);
    const editor = screen.getByRole("textbox");
    editor.textContent = "why this approach?";
    fireEvent.input(editor);
    fireEvent.click(screen.getByRole("button", { name: "별도로 질문하기" }));
    expect(onSideStart).toHaveBeenCalledWith("why this approach?");
    expect(await screen.findByText("메인 세션의 문맥 · 읽기 전용")).toBeInTheDocument();
    expect(screen.getByText("why this approach?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "닫기" }));
    await waitFor(() => expect(onSideClose).toHaveBeenCalledWith("side-1"));
    expect(screen.queryByLabelText("Side 질문")).toBeNull();
  });

  it("shows live-worktree copy and routes worker Side follow-ups independently", async () => {
    const onSideStart = vi.fn(async () => "side-w");
    const onSideSend = vi.fn();
    render(<ConversationPane kind="worker" id="w1" onSend={() => {}} onSideStart={onSideStart} onSideSend={onSideSend} />);
    const mainEditor = screen.getByRole("textbox");
    mainEditor.textContent = "what changed?";
    fireEvent.input(mainEditor);
    fireEvent.click(screen.getByRole("button", { name: "별도로 질문하기" }));
    expect(await screen.findByText("이 워커의 문맥 · live worktree · 읽기 전용")).toBeInTheDocument();
    await act(async () => {
      useStore.setState({ sideConversations: { "side-w": { sourceKind: "worker", sourceId: "w1", status: "idle", items: [{ kind: "message", role: "user", content: "what changed?" }] } } } as never);
    });
    const editors = screen.getAllByRole("textbox");
    const sideEditor = editors.at(-1)!;
    sideEditor.textContent = "which file?";
    fireEvent.input(sideEditor);
    fireEvent.keyDown(sideEditor, { key: "Enter" });
    expect(onSideSend).toHaveBeenCalledWith("side-w", "which file?");
  });

  it("uses registry-provided /btw and /side actions alongside prompt commands", () => {
    render(<ConversationPane kind="master" id="s1" onSend={() => {}} onSideStart={async () => "side-1"} commands={[
      ...SIDE_COMMANDS,
      { id: "review", name: "review", description: "review code", action: { type: "insert-prompt", text: "/review" } },
    ]} />);
    const editor = screen.getByRole("textbox");
    editor.textContent = "/";
    fireEvent.input(editor);
    expect(screen.getByText((_text, el) => el?.textContent === "/btw<질문>")).toBeInTheDocument();
    expect(screen.getByText((_text, el) => el?.textContent === "/side<질문>")).toBeInTheDocument();
    expect(screen.getByText("/review")).toBeInTheDocument();
  });

  it("removes registry Side actions from autocomplete while its drawer is already open", async () => {
    render(<ConversationPane kind="master" id="s1" onSend={() => {}} onSideStart={async () => "side-1"} commands={[
      ...SIDE_COMMANDS,
      { id: "review", name: "review", description: "review code", action: { type: "insert-prompt", text: "/review" } },
    ]} />);
    const editor = screen.getByRole("textbox");
    editor.textContent = "open side";
    fireEvent.input(editor);
    fireEvent.click(screen.getByRole("button", { name: "별도로 질문하기" }));
    await screen.findByLabelText("Side 질문");
    editor.textContent = "/";
    fireEvent.input(editor);
    expect(screen.getByText("/review")).toBeInTheDocument();
    expect(screen.queryByText((_text, el) => el?.textContent === "/btw<질문>")).toBeNull();
    expect(screen.queryByText((_text, el) => el?.textContent === "/side<질문>")).toBeNull();
  });
});

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
