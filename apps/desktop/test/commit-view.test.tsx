import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// MonacoDiff uses monaco-editor, which can't run under jsdom, so replace it with a lightweight dummy.
vi.mock("../src/renderer/components/MonacoDiff.js", () => ({
  MonacoDiff: ({ path, commit }: { path: string; commit?: string }) => <div data-testid="diff">{commit}:{path}</div>,
}));

import { CommitView } from "../src/renderer/components/CommitView.js";

function stubWs(files: Array<{ path: string; status: string; added: number; deleted: number }>) {
  (window as unknown as { rookery: unknown }).rookery = { ws: {
    gitCommitFiles: vi.fn(async () => files),
    gitShowFileDiff: vi.fn(async () => ({ before: "", after: "" })),
    gitCommitInfo: vi.fn(async () => ({ hash: "abc123", shortHash: "abc123", author: "CChuYonng", email: "c@x.com", date: "2026-06-21 10:00", subject: "fix app", body: "more detail line" })),
  } };
}

describe("CommitView", () => {
  beforeEach(() => stubWs([
    { path: "src/app.ts", status: "M", added: 10, deleted: 2 },
    { path: "lib/b.ts", status: "A", added: 5, deleted: 0 },
  ]));

  it("renders the changed-file list and diffs the first by default; clicking switches", async () => {
    render(<CommitView root="/r" hash="abc123" />);
    await waitFor(() => expect(screen.getByText("변경 파일 2")).toBeInTheDocument());
    // Commit details at the top
    expect(screen.getByText("fix app")).toBeInTheDocument();
    expect(screen.getByText("CChuYonng")).toBeInTheDocument();
    expect(screen.getByText("more detail line")).toBeInTheDocument();
    expect(screen.getByText("app.ts")).toBeInTheDocument();
    expect(screen.getByText("b.ts")).toBeInTheDocument();
    // Default selection = first file → its path appears in the diff
    expect(screen.getByTestId("diff").textContent).toContain("abc123:/r/src/app.ts");
    fireEvent.click(screen.getByText("b.ts"));
    expect(screen.getByTestId("diff").textContent).toContain("abc123:/r/lib/b.ts");
  });
});
