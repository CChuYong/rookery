import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CheckpointMenu } from "../src/renderer/components/CheckpointMenu.js";

describe("CheckpointMenu", () => {
  describe("cross-midnight timestamps (audit #80)", () => {
    // Pin "now" so a same-day checkpoint reliably falls within the relative-time window and a checkpoint from the
    // previous day reliably falls outside it, regardless of when this suite actually runs. Only Date is faked
    // (toFake: ["Date"]) — setTimeout/setInterval stay real so `waitFor`'s internal polling still works.
    beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-06-21T14:00:00Z")); });
    afterEach(() => { vi.useRealTimers(); });

    it("shows a relative/date label instead of a bare time so turns across midnight stay in visible order", async () => {
      // Turn 1 the evening before, Turn 2 that same afternoon — hh:mm alone would read Turn 1 (06:07 PM) as later
      // than Turn 2 (02:00 PM), i.e. out of order.
      const fetchCheckpoints = vi.fn().mockResolvedValue([
        { seq: 0, sha: "a", createdAt: "2026-06-20T18:07:00Z" },
        { seq: 1, sha: "b", createdAt: "2026-06-21T14:00:00Z" },
      ]);
      render(<CheckpointMenu fetchCheckpoints={fetchCheckpoints} onRestore={vi.fn()} />);
      fireEvent.click(screen.getByText("되돌리기"));
      await waitFor(() => expect(screen.getByText("턴 1")).toBeInTheDocument());
      // Turn 2 (created exactly "now") reads as the relative-time "방금" ("just now"), not a bare clock time.
      expect(screen.getByText("방금")).toBeInTheDocument();
      // Turn 1 (the day before) is old enough to no longer read as a same-day bare time either — it gets an
      // hours-ago/date label instead of "06:07 PM"/"18:07".
      expect(screen.queryByText("18:07")).toBeNull();
      expect(screen.queryByText(/^06:07/)).toBeNull();
    });
  });

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

  it("re-enables rows after a successful restore so a second restore can be armed/confirmed", async () => {
    const fetchCheckpoints = vi.fn().mockResolvedValue([{ seq: 0, sha: "a", createdAt: "2026-06-20T10:00:00Z" }]);
    const onRestore = vi.fn().mockResolvedValue(undefined);
    render(<CheckpointMenu fetchCheckpoints={fetchCheckpoints} onRestore={onRestore} />);
    fireEvent.click(screen.getByText("되돌리기"));
    await waitFor(() => expect(screen.getByText("턴 1")).toBeInTheDocument());
    fireEvent.click(screen.getByText("턴 1")); // arm
    fireEvent.click(screen.getByText("턴 1")); // confirm → succeeds, closes the menu
    await waitFor(() => expect(onRestore).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    // Reopen: the row must not be stuck disabled from the previous restore.
    fireEvent.click(screen.getByText("되돌리기"));
    await waitFor(() => expect(screen.getByText("턴 1")).toBeInTheDocument());
    expect(screen.getByRole("menuitem")).not.toBeDisabled();
    fireEvent.click(screen.getByText("턴 1")); // arm again
    expect(screen.getByText("정말 복원?")).toBeInTheDocument();
    fireEvent.click(screen.getByText("턴 1")); // confirm again → executes a second restore
    await waitFor(() => expect(onRestore).toHaveBeenCalledTimes(2));
  });
});
