import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Automation } from "@daemon/persistence/repositories.js";
import { RunAutomationDialog } from "../src/renderer/components/RunAutomationDialog.js";

const automation: Automation = {
  id: "a1",
  name: "all vars",
  enabled: true,
  trigger: { kind: "slack" },
  action: {
    kind: "master",
    prompt: "{{message}} {{channel}} {{user}} {{ts}} {{threadTs}} {{team}} {{workerId}} {{repo}} {{branch}} {{status}} {{label}} {{tail}}",
    cwd: "/tmp",
    sessionMode: "fresh",
  },
  model: null,
  effort: null,
  permissionMode: null,
  maxTurns: null,
  costBudgetUsd: null,
  nextRunAt: null,
  lastRunAt: null,
  lastStatus: null,
  lastError: null,
  createdAt: "2026-07-12T00:00:00.000Z",
  provider: "claude",
};

describe("RunAutomationDialog viewport containment", () => {
  it("keeps a large variable form inside a bounded scroll body", () => {
    render(<RunAutomationDialog automation={automation} onClose={vi.fn()} onRun={vi.fn()} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveClass("max-h-[calc(100vh-2rem)]", "overflow-hidden");
    expect(dialog.querySelector("[data-dialog-scroll-body]")).toHaveClass("overflow-y-auto");
    expect(dialog.querySelector("[data-dialog-footer]")).toBeInTheDocument();
    expect(screen.getByText("{{tail}}")).toBeInTheDocument();
  });
});
