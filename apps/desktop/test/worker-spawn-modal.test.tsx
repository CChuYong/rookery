import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { WorkerSpawnModal } from "../src/renderer/components/WorkerSpawnModal.js";
import type { SourceItem } from "@daemon/core/source-intake.js";

const items: SourceItem[] = [
  { provider: "github", id: "1", identifier: "#1", title: "First issue", url: "https://x/1", body: "" },
  { provider: "github", id: "2", identifier: "#2", title: "Second issue", url: "https://x/2", body: "" },
];

function renderModal(searchSource = vi.fn().mockResolvedValue(items), extra: { codexDefaultModel?: string } = {}) {
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
      {...extra}
    />,
  );
  return { onSpawn, onClose, searchSource };
}

// Switches into GitHub source mode and waits for the debounced search to resolve into rendered options.
// Scoped to the results listbox: the model/effort/permission <Select>s also render native <option>s that
// otherwise collide with getByRole("option") queries.
async function openGithubResults() {
  fireEvent.click(screen.getByRole("tab", { name: "GitHub" })); // Segment mode item (audit #52: role="tab", not "button")
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

describe("WorkerSpawnModal provider selector (P1.5 task 4)", () => {
  it("defaults to claude — onSpawn's trailing provider arg is undefined (wire-minimal)", () => {
    const { onSpawn } = renderModal();
    fireEvent.change(screen.getByPlaceholderText(/작업을 적어주세요/), { target: { value: "do the thing" } });
    fireEvent.click(screen.getByText("spawn"));
    expect(onSpawn).toHaveBeenCalledTimes(1);
    expect(onSpawn.mock.calls[0]![7]).toBeUndefined();
  });

  it("selecting codex passes provider \"codex\" as onSpawn's trailing arg", () => {
    const { onSpawn } = renderModal();
    fireEvent.change(screen.getByTitle("에이전트 백엔드"), { target: { value: "codex" } });
    fireEvent.change(screen.getByPlaceholderText(/작업을 적어주세요/), { target: { value: "do the thing" } });
    fireEvent.click(screen.getByText("spawn"));
    expect(onSpawn.mock.calls[0]![7]).toBe("codex");
  });

  it("switching to codex swaps the model <Select> for a free-text <Input> with the codexDefaultModel placeholder", () => {
    renderModal(undefined, { codexDefaultModel: "gpt-5.5" });
    // Claude mode: the model field is a native <select> (the Claude model catalog).
    expect(screen.getByTitle("이 워커 모델 (기본 설정과 무관)").tagName).toBe("SELECT");

    fireEvent.change(screen.getByTitle("에이전트 백엔드"), { target: { value: "codex" } });

    const modelField = screen.getByTitle("이 워커 모델 (기본 설정과 무관)");
    expect(modelField.tagName).toBe("INPUT");
    expect(modelField).toHaveAttribute("placeholder", "gpt-5.5");
  });
});

describe("WorkerSpawnModal cost budget (cost budget guard Task 3)", () => {
  it("empty cost budget → onSpawn's trailing costBudgetUsd arg is undefined", () => {
    const { onSpawn } = renderModal();
    fireEvent.change(screen.getByPlaceholderText(/작업을 적어주세요/), { target: { value: "do the thing" } });
    fireEvent.click(screen.getByText("spawn"));
    expect(onSpawn.mock.calls[0]![8]).toBeUndefined();
  });

  it("entering a numeric cost budget passes it as a number in the trailing onSpawn arg", () => {
    const { onSpawn } = renderModal();
    fireEvent.change(screen.getByTitle("비용 예산 (USD, 이 워커)"), { target: { value: "5" } });
    fireEvent.change(screen.getByPlaceholderText(/작업을 적어주세요/), { target: { value: "do the thing" } });
    fireEvent.click(screen.getByText("spawn"));
    expect(onSpawn.mock.calls[0]![8]).toBe(5);
  });

  it("non-numeric, zero, or negative cost budget → onSpawn's trailing arg is undefined", () => {
    const { onSpawn } = renderModal();
    const input = screen.getByTitle("비용 예산 (USD, 이 워커)");

    fireEvent.change(input, { target: { value: "abc" } });
    fireEvent.change(screen.getByPlaceholderText(/작업을 적어주세요/), { target: { value: "t1" } });
    fireEvent.click(screen.getByText("spawn"));
    expect(onSpawn.mock.calls[0]![8]).toBeUndefined();

    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.click(screen.getByText("spawn"));
    expect(onSpawn.mock.calls[1]![8]).toBeUndefined();

    fireEvent.change(input, { target: { value: "-3" } });
    fireEvent.click(screen.getByText("spawn"));
    expect(onSpawn.mock.calls[2]![8]).toBeUndefined();
  });
});
