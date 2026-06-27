import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ToolBlock } from "../src/renderer/components/ToolBlock.js";
import { spawnedWorkerId } from "../src/renderer/lib/tool-worker.js";

const SPAWN_RESULT = "Spawned 4c8903f8-f751-4ef6-bef6-f3f0a81bfc3c in 'app-server' (worktree branch rookery/4c8903f8-f751-4ef6-bef6-f3f0a81bfc3c).";

describe("ToolBlock file chip", () => {
  it("renders a filename chip for file tools and opens on click", () => {
    const onOpenFile = vi.fn();
    render(<ToolBlock name="Read" status="complete" input='{"file_path":"/r/src/App.tsx"}' onOpenFile={onOpenFile} />);
    const chip = screen.getByRole("button", { name: /App\.tsx/ });
    fireEvent.click(chip);
    expect(onOpenFile).toHaveBeenCalledWith("/r/src/App.tsx");
  });

  it("chip click does NOT toggle the input/result detail", () => {
    render(<ToolBlock name="Read" status="complete" input='{"file_path":"/r/a.ts"}' result="hello" onOpenFile={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /a\.ts/ }));
    expect(screen.queryByText("result")).toBeNull(); // detail area not opened
  });

  it("chevron/body click still toggles detail", () => {
    render(<ToolBlock name="Read" status="complete" input='{"file_path":"/r/a.ts"}' result="hello" onOpenFile={vi.fn()} />);
    fireEvent.click(screen.getByText("Read")); // click the body (toggle)
    expect(screen.getByText("result")).toBeInTheDocument();
  });

  it("no chip for non-file tools", () => {
    render(<ToolBlock name="Bash" status="complete" input='{"command":"ls"}' onOpenFile={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /ls/ })).toBeNull();
  });

  it("no chip when onOpenFile is not provided", () => {
    render(<ToolBlock name="Read" status="complete" input='{"file_path":"/r/a.ts"}' />);
    expect(screen.queryByRole("button", { name: /a\.ts/ })).toBeNull();
  });
});

describe("spawnedWorkerId", () => {
  it("extracts the worker id from a spawn_worker result", () => {
    expect(spawnedWorkerId("spawn_worker", SPAWN_RESULT)).toBe("4c8903f8-f751-4ef6-bef6-f3f0a81bfc3c");
  });
  it("ignores non-spawn tools and empty/failed results", () => {
    expect(spawnedWorkerId("send_worker", "Sent to abc.")).toBeNull();
    expect(spawnedWorkerId("spawn_worker", undefined)).toBeNull();
    expect(spawnedWorkerId("spawn_worker", "spawn failed: nope")).toBeNull();
  });
});

describe("ToolBlock worker chip", () => {
  it("renders a '워커 보기' chip for spawn_worker and navigates on click", () => {
    const onSelectWorker = vi.fn();
    render(<ToolBlock name="spawn_worker" status="complete" result={SPAWN_RESULT} onSelectWorker={onSelectWorker} />);
    fireEvent.click(screen.getByRole("button", { name: /워커 보기/ }));
    expect(onSelectWorker).toHaveBeenCalledWith("4c8903f8-f751-4ef6-bef6-f3f0a81bfc3c");
  });

  it("chip click does NOT toggle the detail", () => {
    render(<ToolBlock name="spawn_worker" status="complete" result={SPAWN_RESULT} onSelectWorker={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /워커 보기/ }));
    expect(screen.queryByText("result")).toBeNull();
  });

  it("no chip without onSelectWorker, for non-spawn tools, or on error", () => {
    const { rerender } = render(<ToolBlock name="spawn_worker" status="complete" result={SPAWN_RESULT} />);
    expect(screen.queryByRole("button", { name: /워커 보기/ })).toBeNull(); // no onSelectWorker
    rerender(<ToolBlock name="Bash" status="complete" result={SPAWN_RESULT} onSelectWorker={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /워커 보기/ })).toBeNull(); // not spawn_worker
    rerender(<ToolBlock name="spawn_worker" status="complete" ok={false} result="spawn failed: x" onSelectWorker={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /워커 보기/ })).toBeNull(); // failed result
  });
});
