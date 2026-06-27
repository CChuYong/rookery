import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CheckpointMenu } from "../src/renderer/components/CheckpointMenu.js";

describe("CheckpointMenu", () => {
  it("fetches on open, requires a 2nd click (arm) before restoring that seq", async () => {
    const fetchCheckpoints = vi.fn().mockResolvedValue([
      { seq: 0, sha: "a", createdAt: "2026-06-20T10:00:00Z" },
      { seq: 1, sha: "b", createdAt: "2026-06-20T10:05:00Z" },
    ]);
    const onRestore = vi.fn();
    render(<CheckpointMenu fetchCheckpoints={fetchCheckpoints} onRestore={onRestore} />);
    fireEvent.click(screen.getByText("되돌리기"));
    expect(fetchCheckpoints).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByText("턴 1")).toBeInTheDocument());
    fireEvent.click(screen.getByText("턴 1")); // 1st click: arm
    expect(onRestore).not.toHaveBeenCalled();
    expect(screen.getByText("정말 복원?")).toBeInTheDocument();
    fireEvent.click(screen.getByText("턴 1")); // 2nd click: execute
    expect(onRestore).toHaveBeenCalledWith(0);
  });
});
