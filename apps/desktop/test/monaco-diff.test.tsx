import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MonacoDiff } from "../src/renderer/components/MonacoDiff.js";
import { __diffInstances as diffs } from "./mocks/monaco-editor.js";

// audit #18: a diff tab tells loading, failure and "no changes" apart instead of showing a blank or identical pane.
function mockWs(gitDiff: ReturnType<typeof vi.fn>) {
  (window as unknown as { rookery: unknown }).rookery = { ws: { gitDiff, gitShowFileDiff: vi.fn() } };
}
beforeEach(() => { diffs.length = 0; });

describe("MonacoDiff states (audit #18)", () => {
  it("shows a loading note until the diff arrives, then the diff", async () => {
    let finish!: (v: { head: string; work: string }) => void;
    mockWs(vi.fn(() => new Promise((r) => { finish = r; })));
    render(<MonacoDiff root="/r" path="/r/a.ts" />);
    expect(screen.getByText("변경 사항을 불러오는 중…")).toBeInTheDocument();
    finish({ head: "a", work: "b" });
    await waitFor(() => expect(screen.queryByText("변경 사항을 불러오는 중…")).toBeNull());
    expect(diffs[0]!.getModel()).not.toBeNull();
  });

  it("shows an error with a retry that loads again", async () => {
    const gitDiff = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({ head: "a", work: "b" });
    mockWs(gitDiff);
    render(<MonacoDiff root="/r" path="/r/a.ts" />);
    expect(await screen.findByText("변경 사항을 불러오지 못했어요.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    await waitFor(() => expect(gitDiff).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText("변경 사항을 불러오지 못했어요.")).toBeNull());
  });

  it("says there are no changes when both sides are identical", async () => {
    mockWs(vi.fn(async () => ({ head: "same", work: "same" })));
    render(<MonacoDiff root="/r" path="/r/a.ts" />);
    expect(await screen.findByText("변경 없음 — 두 쪽 내용이 같아요.")).toBeInTheDocument();
  });
});
