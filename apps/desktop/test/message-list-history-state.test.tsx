import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MessageList } from "../src/renderer/components/MessageList.js";

// History-load state split for the empty transcript (audit #43): while the session.history/worker.history fetch
// is in flight the pane must not claim "empty" — mirrors the loaded/loadFailed idiom already covered for
// AutomationPage/RepoTree (audit #14).
describe("MessageList history-load states (audit #43)", () => {
  it("unloaded (still fetching) → shows a skeleton, not the empty hint", () => {
    const { container } = render(<MessageList items={[]} loaded={false} />);
    expect(container.querySelector(".sheen")).not.toBeNull();
    expect(screen.queryByText(/대화를 시작하세요/)).toBeNull();
    expect(screen.queryByText(/대화가 아직 없어요/)).toBeNull();
  });

  it("loadFailed → shows an error line with a retry control that re-fires the history request", () => {
    const onRetryHistory = vi.fn();
    const { container } = render(<MessageList items={[]} loaded={false} loadFailed onRetryHistory={onRetryHistory} />);
    expect(container.querySelector(".sheen")).toBeNull(); // failed beats the skeleton, not layered on top of it
    const retry = screen.getByText("대화를 불러오지 못했어요 — 다시 시도");
    fireEvent.click(retry);
    expect(onRetryHistory).toHaveBeenCalledTimes(1);
  });

  it("loaded and empty, master kind → the master empty hint", () => {
    render(<MessageList items={[]} loaded kind="master" />);
    expect(screen.getByText("메시지를 입력해 마스터와 대화를 시작하세요.")).toBeInTheDocument();
  });

  it("loaded and empty, worker kind → the worker empty hint, which must not mention the master", () => {
    render(<MessageList items={[]} loaded kind="worker" />);
    const hint = screen.getByText("이 워커와의 대화가 아직 없어요.");
    expect(hint).toBeInTheDocument();
    expect(hint.textContent).not.toContain("마스터");
  });

  it("defaults (no loaded/kind passed) preserve the old immediate master-empty behavior for direct callers", () => {
    const { container } = render(<MessageList items={[]} />);
    expect(container.querySelector(".sheen")).toBeNull();
    expect(screen.getByText("메시지를 입력해 마스터와 대화를 시작하세요.")).toBeInTheDocument();
  });

  it("a later loadFailed after a successful load does not hide already-loaded messages", () => {
    render(<MessageList items={[{ kind: "message", role: "assistant", content: "hi" } as never]} loaded loadFailed />);
    expect(screen.getByText("hi")).toBeInTheDocument();
    expect(screen.queryByText(/대화를 불러오지 못했어요/)).toBeNull();
  });
});
