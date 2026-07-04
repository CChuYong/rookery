import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { TerminalPanel } from "../src/renderer/components/TerminalPanel.js";
import { useTermStore } from "../src/renderer/store/terminals.js";

afterEach(() => {
  cleanup();
  useTermStore.setState({ byPage: {}, layout: {} }); // isolate pages between tests (persist middleware keeps state across renders)
});

// audit #49b: the empty-state hint said "session's working folder" even on worker
// pages, where the panel actually starts in the worker's worktree (App.tsx passes
// subId, cwd=undefined for worker pages — main resolves the worktree cwd from
// ROOKERY_HOME+subId). useT() falls back to ko without a provider, matching the
// other no-provider component tests in this suite.
describe("TerminalPanel empty-state hint (audit #49b)", () => {
  it("master page (no subId): mentions the session's working folder", () => {
    render(<TerminalPanel sessionId="s1" subId={null} cwd="/repo" dock />);
    expect(screen.getByText("＋ 로 터미널을 여세요 — 세션 작업 폴더에서 시작해요.")).toBeInTheDocument();
  });

  it("worker page (subId set): mentions the worker's worktree instead", () => {
    render(<TerminalPanel sessionId="w1" subId="w1" dock />);
    expect(screen.getByText("＋ 로 터미널을 여세요 — 워커 워크트리에서 시작해요.")).toBeInTheDocument();
  });
});
