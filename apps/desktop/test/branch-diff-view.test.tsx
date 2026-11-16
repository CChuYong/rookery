import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { BranchDiffView } from "../src/renderer/components/BranchDiffView.js";
import { WorkspaceTab } from "../src/renderer/components/WorkspaceTab.js";

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,2 +1,2 @@", " keep", "-old", "+new",
  "diff --git a/b.md b/b.md", "new file mode 100644", "--- /dev/null", "+++ b/b.md", "@@ -0,0 +1 @@", "+hello",
].join("\n");

// audit #84: after a worker commits, Git Changes is empty — this tab shows everything it changed since its base.
describe("BranchDiffView", () => {
  it("loads the worker's diff and lists files with counts; picking a file shows its hunks", async () => {
    const loadDiff = vi.fn(async () => DIFF);
    render(<BranchDiffView workerId="w1" loadDiff={loadDiff} />);
    expect(loadDiff).toHaveBeenCalledWith("w1");
    expect(await screen.findByRole("button", { name: /a\.ts/ })).toBeInTheDocument();
    expect(screen.getByText("-old")).toBeInTheDocument(); // first file selected by default
    fireEvent.click(screen.getByRole("button", { name: /b\.md/ }));
    expect(screen.getByText("+hello")).toBeInTheDocument();
    expect(screen.queryByText("-old")).toBeNull();
  });

  it("says so when the branch has no changes against its base", async () => {
    render(<BranchDiffView workerId="w1" loadDiff={async () => ""} />);
    expect(await screen.findByText("기준 브랜치 이후 변경 사항이 없어요")).toBeInTheDocument();
  });

  it("shows an error with a retry when the diff can't be loaded", async () => {
    const loadDiff = vi.fn().mockRejectedValueOnce(new Error("nope")).mockResolvedValueOnce(DIFF);
    render(<BranchDiffView workerId="w1" loadDiff={loadDiff} />);
    fireEvent.click(await screen.findByRole("button", { name: "다시 시도" }));
    await waitFor(() => expect(loadDiff).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("button", { name: /a\.ts/ })).toBeInTheDocument();
  });

  it("says the diff is against the fork point and offers a refresh that reloads it", async () => {
    const loadDiff = vi.fn(async () => DIFF);
    render(<BranchDiffView workerId="w1" loadDiff={loadDiff} />);
    expect(await screen.findByText("분기 시점 대비 변경")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    await waitFor(() => expect(loadDiff).toHaveBeenCalledTimes(2));
  });

  it("shows a notice when the daemon truncated the diff", async () => {
    render(<BranchDiffView workerId="w1" loadDiff={async () => `${DIFF}\n…(truncated)`} />);
    expect(await screen.findByText("변경 사항이 너무 커서 앞부분(512 KB)만 보여요")).toBeInTheDocument();
  });

  it("notes a binary file instead of showing an empty pane", async () => {
    render(<BranchDiffView workerId="w1" loadDiff={async () => "diff --git a/i.png b/i.png\nBinary files a/i.png and b/i.png differ"} />);
    expect(await screen.findByText("바이너리 파일이라 내용 비교를 보여 줄 수 없어요")).toBeInTheDocument();
  });

  // review round 2: a pure rename or a mode-only change has no hunks — say what changed instead of an empty pane.
  it("notes a pure rename and a mode-only change", async () => {
    const diff = ["diff --git a/old.ts b/new.ts", "similarity index 100%", "rename from old.ts", "rename to new.ts", "diff --git a/run.sh b/run.sh", "old mode 100644", "new mode 100755"].join("\n");
    render(<BranchDiffView workerId="w1" loadDiff={async () => diff} />);
    expect(await screen.findByText("이름만 바뀌었어요: old.ts → new.ts")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /run\.sh/ }));
    expect(screen.getByText("파일 모드만 바뀌었어요 (100755)")).toBeInTheDocument();
  });

  it("is what a branch: workspace tab renders", async () => {
    render(<WorkspaceTab activeTab="branch:w1" pageKey="w1" root="/r" loadBranchDiff={async () => DIFF} />);
    expect(await screen.findByRole("button", { name: /a\.ts/ })).toBeInTheDocument();
  });
});
