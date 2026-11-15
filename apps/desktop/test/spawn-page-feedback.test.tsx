import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { WorkerSpawnPage } from "../src/renderer/components/WorkerSpawnPage.js";
import { useDraftStore, emptyDraftState } from "../src/renderer/store/drafts.js";

beforeEach(() => { useDraftStore.setState(emptyDraftState()); });
const base = { repo: "app", defaultModel: "claude-opus-4-8", defaultEffort: "high", onClose: () => {} };
const taskBox = (): HTMLElement => screen.getByPlaceholderText(/작업을 적어주세요/);

// Audit #36: a failed search is not "no results", and the base picker holds its place while branches load or fail.
describe("WorkerSpawnPage source and branch failures", () => {
  it("shows a search failure row instead of 'No results'", async () => {
    const searchSource = vi.fn().mockRejectedValue(new Error("token expired"));
    render(<WorkerSpawnPage {...base} onSpawn={vi.fn()} searchSource={searchSource} integrations={{ github: { available: true }, linear: { configured: false } }} />);
    fireEvent.click(screen.getByRole("tab", { name: "GitHub" }));
    const input = screen.getByPlaceholderText("이슈·PR 검색 (이 레포)");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "bug" } });
    expect(await screen.findByText(/검색하지 못했어요/)).toBeInTheDocument();
    expect(screen.queryByText("결과 없음")).toBeNull();
  });

  it("keeps a disabled base picker in place while branches load", () => {
    render(<WorkerSpawnPage {...base} onSpawn={vi.fn()} branches={[]} branchesState="loading" />);
    const picker = screen.getByRole("combobox", { name: "기준 브랜치" });
    expect(picker).toBeDisabled();
    expect(picker).toHaveTextContent("브랜치 불러오는 중…");
  });

  it("says when the branch list failed and spawns on the repo default", () => {
    const onSpawn = vi.fn();
    render(<WorkerSpawnPage {...base} onSpawn={onSpawn} branches={[]} branchesState="failed" />);
    const picker = screen.getByRole("combobox", { name: "기준 브랜치" });
    expect(picker).toBeDisabled();
    expect(picker).toHaveTextContent(/브랜치를 불러오지 못했어요/);
    fireEvent.click(screen.getByRole("button", { name: "스폰" }));
    expect(onSpawn.mock.calls[0]![4]).toBeUndefined(); // base = repo default
  });
});

// Audit #37: an invalid budget is an error, not a silently dropped safety limit.
describe("WorkerSpawnPage cost budget validation", () => {
  it.each(["abc", "0", "-3"])("blocks the spawn on %s, opens More and explains", (value) => {
    const onSpawn = vi.fn();
    render(<WorkerSpawnPage {...base} onSpawn={onSpawn} />);
    fireEvent.change(screen.getByTitle("비용 예산 (USD, 이 워커)"), { target: { value } });
    fireEvent.change(taskBox(), { target: { value: "t1" } });
    // collapsed More shows an error marker
    expect(screen.getByRole("button", { name: /더보기/ })).toHaveAccessibleDescription(/0보다 큰 금액/);
    fireEvent.click(screen.getByRole("button", { name: "스폰" }));
    expect(onSpawn).not.toHaveBeenCalled();
    expect(screen.getByTitle("비용 예산 (USD, 이 워커)")).toBeVisible();
    expect(screen.getByTitle("비용 예산 (USD, 이 워커)")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(/0보다 큰 금액/, { selector: "p" })).toBeVisible();
  });
});

// Audit #86: one submit key across the three composers — Enter sends, Shift+Enter is a newline.
describe("WorkerSpawnPage submit key", () => {
  it("spawns on Enter and keeps Shift+Enter for a newline", async () => {
    const onSpawn = vi.fn();
    render(<WorkerSpawnPage {...base} onSpawn={onSpawn} />);
    fireEvent.change(taskBox(), { target: { value: "do it" } });
    fireEvent.keyDown(taskBox(), { key: "Enter", shiftKey: true });
    expect(onSpawn).not.toHaveBeenCalled();
    fireEvent.keyDown(taskBox(), { key: "Enter" });
    await waitFor(() => expect(onSpawn).toHaveBeenCalledTimes(1));
  });

  it("puts permission mode and speed in the model menu with model and effort", () => {
    render(<WorkerSpawnPage {...base} onSpawn={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Opus 4\.8 · 높음/ }));
    const menu = screen.getByRole("dialog");
    expect(menu).toContainElement(screen.getByRole("combobox", { name: "권한 모드" }));
    expect(menu).toContainElement(screen.getByRole("combobox", { name: "속도" }));
    expect(menu).toContainElement(screen.getByTitle("백엔드"));
  });
});
