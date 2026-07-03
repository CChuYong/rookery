import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CheckpointMenu } from "../src/renderer/components/CheckpointMenu.js";

describe("CheckpointMenu", () => {
  it("fetches on open, requires a 2nd click (arm) before restoring that seq", async () => {
    const fetchCheckpoints = vi.fn().mockResolvedValue([
      { seq: 0, sha: "a", createdAt: "2026-06-20T10:00:00Z" },
      { seq: 1, sha: "b", createdAt: "2026-06-20T10:05:00Z" },
    ]);
    const onRestore = vi.fn().mockResolvedValue(undefined);
    render(<CheckpointMenu fetchCheckpoints={fetchCheckpoints} onRestore={onRestore} />);
    fireEvent.click(screen.getByText("되돌리기"));
    expect(fetchCheckpoints).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByText("턴 1")).toBeInTheDocument());
    fireEvent.click(screen.getByText("턴 1")); // 1st click: arm
    expect(onRestore).not.toHaveBeenCalled();
    expect(screen.getByText("정말 복원?")).toBeInTheDocument();
    fireEvent.click(screen.getByText("턴 1")); // 2nd click: execute
    expect(onRestore).toHaveBeenCalledWith(0);
    // Closes only after the restore promise settles (success here) — the menu should disappear.
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("shows an error state with a retry button when the fetch rejects, not the empty copy", async () => {
    const fetchCheckpoints = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce([]);
    const onRestore = vi.fn();
    render(<CheckpointMenu fetchCheckpoints={fetchCheckpoints} onRestore={onRestore} />);
    fireEvent.click(screen.getByText("되돌리기"));
    await waitFor(() => expect(screen.getByText("목록을 불러오지 못했어요 — 다시 시도")).toBeInTheDocument());
    expect(screen.queryByText("체크포인트 없음")).toBeNull();
    // Retry re-runs the fetch; this time it resolves to an empty list → the real empty copy shows, not loadFailed.
    fireEvent.click(screen.getByText("목록을 불러오지 못했어요 — 다시 시도"));
    expect(fetchCheckpoints).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.getByText("체크포인트 없음")).toBeInTheDocument());
    expect(screen.queryByText("목록을 불러오지 못했어요 — 다시 시도")).toBeNull();
  });

  it("keeps the menu open and lets the user retry when restore fails", async () => {
    const fetchCheckpoints = vi.fn().mockResolvedValue([{ seq: 0, sha: "a", createdAt: "2026-06-20T10:00:00Z" }]);
    const onRestore = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(undefined);
    render(<CheckpointMenu fetchCheckpoints={fetchCheckpoints} onRestore={onRestore} />);
    fireEvent.click(screen.getByText("되돌리기"));
    await waitFor(() => expect(screen.getByText("턴 1")).toBeInTheDocument());
    fireEvent.click(screen.getByText("턴 1")); // arm
    fireEvent.click(screen.getByText("턴 1")); // confirm → rejects
    await waitFor(() => expect(onRestore).toHaveBeenCalledTimes(1));
    // Failure keeps the menu open (not closed) so the user can retry.
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("턴 1")).toBeInTheDocument());
    fireEvent.click(screen.getByText("턴 1")); // re-arm
    fireEvent.click(screen.getByText("턴 1")); // confirm → succeeds
    await waitFor(() => expect(onRestore).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });
});
