import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Monaco/image components are heavy in jsdom, so stub them out — only verify routing (branch selection).
vi.mock("../src/renderer/components/MonacoEditor.js", () => ({ MonacoEditor: (p: { path: string }) => <div data-testid="editor">{p.path}</div> }));
vi.mock("../src/renderer/components/MonacoDiff.js", () => ({ MonacoDiff: (p: { root: string; path: string }) => <div data-testid="diff">{p.path}</div> }));
vi.mock("../src/renderer/components/CommitView.js", () => ({ CommitView: (p: { hash: string }) => <div data-testid="commit">{p.hash}</div> }));
vi.mock("../src/renderer/components/ImagePreview.js", () => ({ ImagePreview: (p: { path: string }) => <div data-testid="image">{p.path}</div> }));

import { WorkspaceTab } from "../src/renderer/components/WorkspaceTab.js";

describe("WorkspaceTab routing", () => {
  it("file: → MonacoEditor with the path", () => {
    render(<WorkspaceTab activeTab="file:/r/a.ts" pageKey="p" root="/r" />);
    expect(screen.getByTestId("editor").textContent).toBe("/r/a.ts");
  });
  it("file: image → ImagePreview", () => {
    render(<WorkspaceTab activeTab="file:/r/logo.png" pageKey="p" root="/r" />);
    expect(screen.getByTestId("image")).toBeInTheDocument();
  });
  it("commit: → CommitView with the hash (not a broken diff path)", () => {
    render(<WorkspaceTab activeTab="commit:abc123" pageKey="p" root="/r" />);
    expect(screen.getByTestId("commit").textContent).toBe("abc123");
    expect(screen.queryByTestId("diff")).toBeNull();
  });
  it("diff: → MonacoDiff with the path", () => {
    render(<WorkspaceTab activeTab="diff:/r/a.ts" pageKey="p" root="/r" />);
    expect(screen.getByTestId("diff").textContent).toBe("/r/a.ts");
  });
});
