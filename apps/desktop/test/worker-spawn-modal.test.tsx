import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { WorkerSpawnModal } from "../src/renderer/components/WorkerSpawnModal.js";
import type { SourceItem } from "@daemon/core/source-intake.js";

const items: SourceItem[] = [
  { provider: "github", id: "1", identifier: "#1", title: "First issue", url: "https://x/1", body: "" },
  { provider: "github", id: "2", identifier: "#2", title: "Second issue", url: "https://x/2", body: "" },
];

function renderModal(searchSource = vi.fn().mockResolvedValue(items)) {
  const onSpawn = vi.fn();
  const onClose = vi.fn();
  render(
    <WorkerSpawnModal
      repo="app"
      defaultModel="claude-opus-4-8"
      defaultEffort="high"
      integrations={{ github: { available: true }, linear: { configured: false } }}
      searchSource={searchSource}
      onSpawn={onSpawn}
      onClose={onClose}
    />,
  );
  return { onSpawn, onClose, searchSource };
}

// Switches into GitHub source mode and waits for the debounced search to resolve into rendered options.
// Scoped to the results listbox: the model/effort/permission <Select>s also render native <option>s that
// otherwise collide with getByRole("option") queries.
async function openGithubResults() {
  fireEvent.click(screen.getByRole("button", { name: "GitHub" }));
  const input = screen.getByPlaceholderText("이슈·PR 검색 (이 레포)");
  fireEvent.focus(input);
  await waitFor(() => expect(within(screen.getByRole("listbox")).getAllByRole("option")).toHaveLength(2));
  return input;
}

describe("WorkerSpawnModal source search keyboard nav (audit #27)", () => {
  it("ArrowDown highlights the first result and Enter selects it (same handler as a result's onClick)", async () => {
    renderModal();
    const input = await openGithubResults();
    const list = within(screen.getByRole("listbox"));

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(list.getByRole("option", { name: /First issue/ })).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(input, { key: "Enter" });
    // Selecting collapses the search UI into the "selected" chip showing the picked item.
    expect(screen.getByText("#1")).toBeInTheDocument();
    expect(screen.getByText("First issue")).toBeInTheDocument();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("ArrowDown twice then Enter selects the second result, not the first", async () => {
    renderModal();
    const input = await openGithubResults();
    const list = within(screen.getByRole("listbox"));

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(list.getByRole("option", { name: /Second issue/ })).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("#2")).toBeInTheDocument();
  });

  it("ArrowDown clamps at the last result instead of wrapping around", async () => {
    renderModal();
    const input = await openGithubResults();
    const list = within(screen.getByRole("listbox"));

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" }); // one past the end
    expect(list.getByRole("option", { name: /Second issue/ })).toHaveAttribute("aria-selected", "true");
  });

  it("clicking a result still works (the onMouseDown preventDefault guard doesn't swallow the click)", async () => {
    renderModal();
    await openGithubResults();

    const secondOption = within(screen.getByRole("listbox")).getByRole("option", { name: /Second issue/ });
    fireEvent.mouseDown(secondOption);
    fireEvent.click(secondOption);
    expect(screen.getByText("#2")).toBeInTheDocument();
  });
});
