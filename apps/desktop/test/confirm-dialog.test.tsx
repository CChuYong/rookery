import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ConfirmDialog } from "../src/renderer/ui/confirm-dialog.js";

// The shared confirm (audit #73) is the one dialog for irreversible actions (audit #103) and now also carries an
// optional middle action so three-way prompts (Settings' Discard / Save) stop hand-rolling their own modal (audit #102).
describe("ConfirmDialog", () => {
  it("cancel is focused first and confirm runs onConfirm", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<ConfirmDialog title="Delete it?" body="Gone for good." confirmLabel="Delete" variant="danger" onConfirm={onConfirm} onCancel={onCancel} />);
    expect(screen.getByRole("dialog", { name: "Delete it?" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "취소" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1)); // the dialog's own exit closes it
  });

  it("renders an optional secondary action between cancel and confirm", () => {
    const onSecondary = vi.fn();
    const onConfirm = vi.fn();
    render(<ConfirmDialog title="Unsaved" body="Lose changes?" confirmLabel="Save" secondary={{ label: "Discard", onClick: onSecondary }} onConfirm={onConfirm} onCancel={() => {}} />);
    const labels = screen.getAllByRole("button").map((b) => b.textContent);
    expect(labels).toEqual(["취소", "Discard", "Save"]);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(onSecondary).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("uses the shared dialog panel (lifted, 8px radius, 20px padding)", () => {
    render(<ConfirmDialog title="T" body="B" confirmLabel="OK" onConfirm={() => {}} onCancel={() => {}} />);
    const panel = screen.getByRole("dialog");
    expect(panel.className).toContain("shadow-pop");
    expect(panel.className).toContain("rounded-xl");
    expect(panel.className).toContain("p-5");
  });
});
