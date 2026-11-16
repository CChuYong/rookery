import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { WorkerSpawnPage } from "../src/renderer/components/WorkerSpawnPage.js";
import { useStore } from "../src/renderer/store/store.js";
import { useDraftStore, emptyDraftState } from "../src/renderer/store/drafts.js";
import type { ComponentProps } from "react";
import type { SourceItem } from "@daemon/core/source-intake.js";
import type { CodexModelInfo } from "@daemon/protocol/messages.js";

describe("WorkerSpawnPage", () => {
  // The page persists its task/label in the drafts store; start every test from an empty store.
  beforeEach(() => { useDraftStore.setState(emptyDraftState()); });

  it("renders as a scrollable full page: one heading naming the repo, one task box, quiet meta controls", () => {
    render(<WorkerSpawnPage repo="app" defaultModel="claude-opus-4-8" defaultEffort="high" branches={["main"]} onSpawn={() => {}} onClose={() => {}} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("region", { name: "새 워커" })).toHaveClass("overflow-y-auto");
    expect(screen.getByRole("heading", { name: /app\s?에서 워커에게 무엇을 맡길까요\?/ })).toBeInTheDocument();
    expect(screen.queryByText("app", { selector: ".text-muted *" })).toBeNull(); // no separate repo label under the box
    // where/how controls sit under the box with accessible names
    expect(screen.getByRole("combobox", { name: "기준 브랜치" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "권한 모드" })).toBeInTheDocument();
  });

  it("keeps rarely-used options (label, cost budget) behind More", () => {
    render(<WorkerSpawnPage repo="app" defaultModel="claude-opus-4-8" defaultEffort="high" onSpawn={() => {}} onClose={() => {}} />);
    const label = screen.getByPlaceholderText("label (선택)");
    expect(label).not.toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /더보기/ }));
    expect(label).toBeVisible();
    expect(screen.getByText("비용 예산 (USD, 이 워커)")).toBeVisible();
  });

  it("switches the target repo from the meta row", () => {
    const onRepoChange = vi.fn();
    render(<WorkerSpawnPage repo="app" repos={[{ name: "app", path: "/app" }, { name: "web", path: "/web" }]} onRepoChange={onRepoChange} defaultModel="claude-opus-4-8" defaultEffort="high" onSpawn={() => {}} onClose={() => {}} />);
    const repo = screen.getByRole("combobox", { name: "레포" });
    expect(repo).toHaveValue("app");
    fireEvent.change(repo, { target: { value: "web" } });
    expect(onRepoChange).toHaveBeenCalledWith("web");
  });

  it("keeps the prompt and dialog open on Escape, then closes only from Cancel", async () => {
    const onClose = vi.fn();
    render(<WorkerSpawnPage repo="app" defaultModel="claude-opus-4-8" defaultEffort="high" onSpawn={() => {}} onClose={onClose} />);
    const prompt = screen.getByPlaceholderText(/Ctrl\+Enter/);
    fireEvent.change(prompt, { target: { value: "keep this worktree prompt" } });

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).not.toHaveBeenCalled();
    expect(prompt).toHaveValue("keep this worktree prompt");
    expect(screen.getByRole("region", { name: "새 워커" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "닫기" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("stays open and blocks duplicate submits while spawn is pending, then closes on success", async () => {
    let resolveSpawn!: () => void;
    const pending = new Promise<void>((resolve) => { resolveSpawn = resolve; });
    const onSpawn = vi.fn(() => pending);
    const onClose = vi.fn();
    render(<WorkerSpawnPage repo="app" defaultModel="claude-opus-4-8" defaultEffort="high" onSpawn={onSpawn} onClose={onClose} />);
    fireEvent.change(screen.getByPlaceholderText(/Ctrl\+Enter/), { target: { value: "spawn once" } });
    const spawnButton = screen.getByRole("button", { name: "spawn" });

    fireEvent.click(spawnButton);

    expect(onSpawn).toHaveBeenCalledTimes(1);
    expect(spawnButton).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "닫기" })).toBeDisabled();
    fireEvent.keyDown(screen.getByPlaceholderText(/Ctrl\+Enter/), { key: "Enter", ctrlKey: true });
    expect(onSpawn).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      resolveSpawn();
      await pending;
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("keeps the complete prompt available for retry when spawn rejects", async () => {
    const onSpawn = vi.fn().mockRejectedValue(new Error("daemon unavailable"));
    const onClose = vi.fn();
    render(<WorkerSpawnPage repo="app" defaultModel="claude-opus-4-8" defaultEffort="high" onSpawn={onSpawn} onClose={onClose} />);
    const prompt = screen.getByPlaceholderText(/Ctrl\+Enter/);
    fireEvent.change(prompt, { target: { value: "preserve this after failure" } });

    fireEvent.click(screen.getByRole("button", { name: "spawn" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "spawn" })).not.toHaveAttribute("aria-busy"));
    expect(onClose).not.toHaveBeenCalled();
    expect(prompt).toHaveValue("preserve this after failure");
    expect(screen.getByRole("region", { name: "새 워커" })).toBeInTheDocument();
  });

  it("defaults to direct-write mode (no search box) and passes base through onSpawn", () => {
    const onSpawn = vi.fn();
    render(<WorkerSpawnPage repo="app" defaultModel="claude-opus-4-8" defaultEffort="high" branches={["main", "dev"]} onSpawn={onSpawn} onClose={() => {}} />);
    // Direct-write mode: no search box
    expect(screen.queryByPlaceholderText(/검색/)).toBeNull();
    fireEvent.change(screen.getByTitle(/base 브랜치/), { target: { value: "dev" } });
    fireEvent.change(screen.getByPlaceholderText(/Ctrl\+Enter/), { target: { value: "do it" } });
    fireEvent.click(screen.getByRole("button", { name: "spawn" }));
    expect(onSpawn).toHaveBeenCalledWith("do it", "", "claude-opus-4-8", "high", "dev", undefined, "bypassPermissions", undefined, undefined); // no ticket → undefined; default permission; default provider (claude) → undefined; no cost budget → undefined
  });

  it("defaults permission to bypassPermissions and threads the selected mode (plan) through onSpawn", () => {
    const onSpawn = vi.fn();
    render(<WorkerSpawnPage repo="app" defaultModel="claude-opus-4-8" defaultEffort="high" onSpawn={onSpawn} onClose={() => {}} />);
    const sel = screen.getByTitle(/권한 모드|Permission mode/) as HTMLSelectElement;
    expect(sel.value).toBe("bypassPermissions");
    // restricted to bypass + plan (no default/acceptEdits)
    expect(screen.getByText("Plan Mode")).toBeInTheDocument();
    expect(screen.queryByText("Accept Edits")).toBeNull();
    fireEvent.change(sel, { target: { value: "plan" } });
    fireEvent.click(screen.getByRole("button", { name: "spawn" }));
    expect(onSpawn.mock.calls.at(-1)).toEqual(["", "", "claude-opus-4-8", "high", undefined, undefined, "plan", undefined, undefined]);
  });

  it("passes the selected ticket {key,url} to onSpawn", async () => {
    const items: SourceItem[] = [{ provider: "linear", id: "1", identifier: "ABC-7", title: "Ship it", url: "https://l/ABC-7", body: "do it", state: "Todo" }];
    const onSpawn = vi.fn();
    render(<WorkerSpawnPage repo="app" defaultModel="claude-opus-4-8" defaultEffort="high"
      integrations={{ github: { available: false }, linear: { configured: true, valid: true } }}
      searchSource={async () => items} onSpawn={onSpawn} onClose={() => {}} />);
    fireEvent.click(screen.getByText("Linear"));
    const input = screen.getByPlaceholderText(/티켓 검색/);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "ship" } });
    fireEvent.click(await screen.findByText(/ABC-7/));
    await waitFor(() => expect((screen.getByPlaceholderText(/Ctrl\+Enter/) as HTMLTextAreaElement).value).toContain("do it"));
    fireEvent.click(screen.getByRole("button", { name: "spawn" }));
    expect(onSpawn.mock.calls.at(-1)![5]).toEqual({ key: "ABC-7", url: "https://l/ABC-7" });
  });

  it("disables a source segment when its integration is not connected", () => {
    render(<WorkerSpawnPage repo="app" defaultModel="claude-opus-4-8" defaultEffort="high"
      integrations={{ github: { available: false }, linear: { configured: false } }}
      searchSource={async () => []} onSpawn={() => {}} onClose={() => {}} />);
    expect(screen.getByText("GitHub")).toBeDisabled();
    expect(screen.getByText("Linear")).toBeDisabled();
    expect(screen.getByText("직접 작성")).not.toBeDisabled();
  });

  it("switches to Linear mode, searches, and fills task+label on select", async () => {
    const items: SourceItem[] = [{ provider: "linear", id: "1", identifier: "ABC-7", title: "Ship it", url: "https://l/ABC-7", body: "do it", state: "Todo" }];
    const searchSource = vi.fn(async () => items);
    render(<WorkerSpawnPage repo="app" defaultModel="claude-opus-4-8" defaultEffort="high"
      integrations={{ github: { available: false }, linear: { configured: true, valid: true } }}
      searchSource={searchSource} onSpawn={() => {}} onClose={() => {}} />);
    fireEvent.click(screen.getByText("Linear"));
    const input = screen.getByPlaceholderText(/티켓 검색/);
    fireEvent.focus(input); // dropdown is shown only while focused
    fireEvent.change(input, { target: { value: "ship" } });
    await waitFor(() => expect(searchSource).toHaveBeenCalledWith("linear", "ship"));
    fireEvent.click(await screen.findByText(/ABC-7/));
    await waitFor(() => expect((screen.getByPlaceholderText(/Ctrl\+Enter/) as HTMLTextAreaElement).value).toContain("do it"));
    expect((screen.getByPlaceholderText("label (선택)") as HTMLInputElement).value).toBe("ABC-7 Ship it");
    // after selection it shows as a chip and the search box disappears
    expect(screen.queryByPlaceholderText(/티켓 검색/)).toBeNull();
  });

  it("empty task → spawn button calls onSpawn with task='' (idle worker)", () => {
    const onSpawn = vi.fn();
    render(<WorkerSpawnPage repo="app" defaultModel="claude-opus-4-8" defaultEffort="high" onSpawn={onSpawn} onClose={() => {}} />);
    // task left empty (default), click spawn
    fireEvent.click(screen.getByRole("button", { name: "spawn" }));
    expect(onSpawn).toHaveBeenCalledWith("", "", "claude-opus-4-8", "high", undefined, undefined, "bypassPermissions", undefined, undefined);
  });

  it("non-empty task → spawn button still calls onSpawn with trimmed task", () => {
    const onSpawn = vi.fn();
    render(<WorkerSpawnPage repo="app" defaultModel="claude-opus-4-8" defaultEffort="high" onSpawn={onSpawn} onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/Ctrl\+Enter/), { target: { value: "fix the bug" } });
    fireEvent.click(screen.getByRole("button", { name: "spawn" }));
    expect(onSpawn).toHaveBeenCalledWith("fix the bug", "", "claude-opus-4-8", "high", undefined, undefined, "bypassPermissions", undefined, undefined);
  });

  it("shows the results dropdown only while the search box is focused", async () => {
    const items: SourceItem[] = [{ provider: "linear", id: "1", identifier: "ABC-7", title: "Ship it", url: "https://l/ABC-7", body: "do it" }];
    const searchSource = vi.fn(async () => items);
    render(<WorkerSpawnPage repo="app" defaultModel="claude-opus-4-8" defaultEffort="high"
      integrations={{ github: { available: false }, linear: { configured: true, valid: true } }}
      searchSource={searchSource} onSpawn={() => {}} onClose={() => {}} />);
    fireEvent.click(screen.getByText("Linear"));
    const input = screen.getByPlaceholderText(/티켓 검색/);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "ship" } });
    expect(await screen.findByText(/ABC-7/)).toBeInTheDocument();
    fireEvent.blur(input);
    await waitFor(() => expect(screen.queryByText(/ABC-7/)).toBeNull());
  });
});

const CODEX_MODELS: CodexModelInfo[] = [
  { id: "gpt-5.5", displayName: "GPT-5.5", defaultEffort: "xhigh", supportedEfforts: ["low", "medium", "high", "xhigh"], isDefault: true },
  { id: "gpt-5.4", displayName: "GPT-5.4", defaultEffort: "medium", supportedEfforts: ["low", "medium", "high"], isDefault: false },
];

describe("WorkerSpawnPage codex model+effort onSpawn payload (Codex Model Picker Task 3)", () => {
  beforeEach(() => {
    useStore.setState({ codexModels: null }); // reset the singleton store before each test
    useDraftStore.setState(emptyDraftState());
  });

  it("codexModels seeded — onSpawn carries the dropdown-selected model + its pre-selected default effort", () => {
    useStore.getState().setCodexModels(CODEX_MODELS);
    const onSpawn = vi.fn();
    render(<WorkerSpawnPage repo="app" defaultModel="claude-opus-4-8" defaultEffort="high" onSpawn={onSpawn} onClose={() => {}} />);
    fireEvent.change(screen.getByTitle("에이전트 백엔드"), { target: { value: "codex" } });
    fireEvent.change(screen.getByTitle("이 워커 모델 (기본 설정과 무관)"), { target: { value: "gpt-5.5" } });
    fireEvent.click(screen.getByRole("button", { name: "spawn" }));
    expect(onSpawn.mock.calls.at(-1)).toEqual(["", "", "gpt-5.5", "xhigh", undefined, undefined, "bypassPermissions", "codex", undefined]);
  });

  it("codexModels null — onSpawn still carries the typed free-text model + the generic default effort", () => {
    const onSpawn = vi.fn();
    render(<WorkerSpawnPage repo="app" defaultModel="claude-opus-4-8" defaultEffort="high" onSpawn={onSpawn} onClose={() => {}} />);
    fireEvent.change(screen.getByTitle("에이전트 백엔드"), { target: { value: "codex" } });
    fireEvent.change(screen.getByTitle("이 워커 모델 (기본 설정과 무관)"), { target: { value: "gpt-6" } });
    fireEvent.click(screen.getByRole("button", { name: "spawn" }));
    expect(onSpawn.mock.calls.at(-1)).toEqual(["", "", "gpt-6", "high", undefined, undefined, "bypassPermissions", "codex", undefined]); // effort defaults from p.defaultEffort, unchanged by the (absent) catalog
  });

  it("spawns with Cmd/Ctrl+Enter from inside the form", () => {
    const onSpawn = vi.fn();
    render(<WorkerSpawnPage repo="app" defaultModel="claude-opus-4-8" defaultEffort="high" onSpawn={onSpawn} onClose={() => {}} />);
    const prompt = screen.getByPlaceholderText(/Ctrl\+Enter/);
    fireEvent.change(prompt, { target: { value: "do it" } });
    fireEvent.keyDown(prompt, { key: "Enter", metaKey: true });
    expect(onSpawn).toHaveBeenCalledTimes(1);
  });

  it("does not capture window-level keys (sidebar menus keep their Escape, outside Cmd+Enter does nothing)", () => {
    const onSpawn = vi.fn();
    render(<WorkerSpawnPage repo="app" defaultModel="claude-opus-4-8" defaultEffort="high" onSpawn={onSpawn} onClose={() => {}} />);
    const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    window.dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(false);
    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
    expect(onSpawn).not.toHaveBeenCalled();
  });

  it("switching repo keeps the typed task but resets the repo-bound base branch", () => {
    const repos = [{ name: "app", path: "/app" }, { name: "web", path: "/web" }];
    const { rerender } = render(<WorkerSpawnPage repo="app" repos={repos} onRepoChange={() => {}} branches={["main", "dev"]} defaultModel="claude-opus-4-8" defaultEffort="high" onSpawn={() => {}} onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/Ctrl\+Enter/), { target: { value: "keep me" } });
    fireEvent.change(screen.getByTitle(/Base branch|기준|worktree/), { target: { value: "dev" } });
    rerender(<WorkerSpawnPage repo="web" repos={repos} onRepoChange={() => {}} branches={["main"]} defaultModel="claude-opus-4-8" defaultEffort="high" onSpawn={() => {}} onClose={() => {}} />);
    expect(screen.getByPlaceholderText(/Ctrl\+Enter/)).toHaveValue("keep me");
    expect(screen.getByTitle(/Base branch|기준|worktree/)).toHaveValue("");
  });
});

describe("WorkerSpawnPage draft (spawnWorker:<repo>)", () => {
  beforeEach(() => { useDraftStore.setState(emptyDraftState()); });
  const page = (repo: string, extra: Partial<ComponentProps<typeof WorkerSpawnPage>> = {}) => (
    <WorkerSpawnPage repo={repo} defaultModel="claude-opus-4-8" defaultEffort="high" onSpawn={() => {}} onClose={() => {}} {...extra} />
  );

  it("restores the typed task and label after the page is closed and reopened", () => {
    const first = render(page("app"));
    fireEvent.change(screen.getByPlaceholderText(/Ctrl\+Enter/), { target: { value: "half-written task" } });
    fireEvent.change(screen.getByPlaceholderText("label (선택)"), { target: { value: "my label" } });
    first.unmount();
    expect(useDraftStore.getState().byPage["spawnWorker:app"]).toEqual({ text: "half-written task", images: [], label: "my label" });

    render(page("app"));
    expect(screen.getByPlaceholderText(/Ctrl\+Enter/)).toHaveValue("half-written task");
    expect(screen.getByPlaceholderText("label (선택)")).toHaveValue("my label");
  });

  it("keeps drafts per repo", () => {
    useDraftStore.getState().setSpawnDraft_("web", "web task", "");
    render(page("app"));
    expect(screen.getByPlaceholderText(/Ctrl\+Enter/)).toHaveValue("");
  });

  it("clears the draft after a successful spawn", async () => {
    const onClose = vi.fn();
    render(page("app", { onSpawn: () => Promise.resolve(), onClose }));
    fireEvent.change(screen.getByPlaceholderText(/Ctrl\+Enter/), { target: { value: "ship it" } });
    fireEvent.click(screen.getByRole("button", { name: "spawn" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(useDraftStore.getState().byPage["spawnWorker:app"]).toBeUndefined();
  });

  it("keeps the draft when the spawn fails", async () => {
    render(page("app", { onSpawn: () => Promise.reject(new Error("boom")) }));
    fireEvent.change(screen.getByPlaceholderText(/Ctrl\+Enter/), { target: { value: "retry me" } });
    fireEvent.click(screen.getByRole("button", { name: "spawn" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "spawn" })).not.toHaveAttribute("aria-busy"));
    expect(useDraftStore.getState().byPage["spawnWorker:app"]?.text).toBe("retry me");
  });

  it("carries the draft to the newly picked repo (App remounts the page on repo switch)", () => {
    const repos = [{ name: "app", path: "/app" }, { name: "web", path: "/web" }];
    const onRepoChange = vi.fn();
    const first = render(page("app", { repos, onRepoChange }));
    fireEvent.change(screen.getByPlaceholderText(/Ctrl\+Enter/), { target: { value: "move with me" } });
    fireEvent.change(screen.getByRole("combobox", { name: "레포" }), { target: { value: "web" } });
    expect(onRepoChange).toHaveBeenCalledWith("web");
    first.unmount();
    expect(useDraftStore.getState().byPage["spawnWorker:app"]).toBeUndefined();
    render(page("web", { repos, onRepoChange }));
    expect(screen.getByPlaceholderText(/Ctrl\+Enter/)).toHaveValue("move with me");
  });

  it("does not overwrite another repo's existing draft on repo switch", () => {
    const repos = [{ name: "app", path: "/app" }, { name: "web", path: "/web" }];
    useDraftStore.getState().setSpawnDraft_("web", "web's own draft", "");
    const first = render(page("app", { repos, onRepoChange: () => {} }));
    fireEvent.change(screen.getByPlaceholderText(/Ctrl\+Enter/), { target: { value: "app draft" } });
    fireEvent.change(screen.getByRole("combobox", { name: "레포" }), { target: { value: "web" } });
    first.unmount();
    expect(useDraftStore.getState().byPage["spawnWorker:app"]?.text).toBe("app draft");
    render(page("web", { repos, onRepoChange: () => {} }));
    expect(screen.getByPlaceholderText(/Ctrl\+Enter/)).toHaveValue("web's own draft");
  });

  it("restores the picked ticket with the draft, so a reopened page still spawns with ticketKey/ticketUrl", async () => {
    const items: SourceItem[] = [{ provider: "linear", id: "1", identifier: "ABC-7", title: "Ship it", url: "https://l/ABC-7", body: "do it", state: "Todo" }];
    const integrations = { github: { available: false }, linear: { configured: true, valid: true } };
    const first = render(page("app", { integrations, searchSource: async () => items }));
    fireEvent.click(screen.getByText("Linear"));
    const input = screen.getByPlaceholderText(/티켓 검색/);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "ship" } });
    fireEvent.click(await screen.findByText(/ABC-7/));
    await waitFor(() => expect((screen.getByPlaceholderText(/Ctrl\+Enter/) as HTMLTextAreaElement).value).toContain("do it"));
    first.unmount();
    expect(useDraftStore.getState().byPage["spawnWorker:app"]?.source).toEqual({ provider: "linear", id: "1", identifier: "ABC-7", title: "Ship it", url: "https://l/ABC-7" });

    const onSpawn = vi.fn(() => Promise.resolve());
    render(page("app", { integrations, searchSource: async () => items, onSpawn }));
    // The picked ticket is shown again (Linear mode, chip instead of the search box) and rides on the spawn.
    expect(screen.getByText("ABC-7")).toBeInTheDocument();
    expect(screen.getByText("Ship it")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/티켓 검색/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "spawn" }));
    await waitFor(() => expect(onSpawn).toHaveBeenCalledTimes(1));
    expect((onSpawn.mock.calls[0] as unknown[])[5]).toEqual({ key: "ABC-7", url: "https://l/ABC-7" });
    await waitFor(() => expect(useDraftStore.getState().byPage["spawnWorker:app"]).toBeUndefined());
  });

  it("clearing the picked ticket or switching mode drops it from the draft", async () => {
    const source = { provider: "linear" as const, id: "1", identifier: "ABC-7", title: "Ship it", url: "https://l/ABC-7" };
    const integrations = { github: { available: true }, linear: { configured: true, valid: true } };
    useDraftStore.getState().setSpawnDraft_("app", "task", "ABC-7", source);
    const first = render(page("app", { integrations, searchSource: async () => [] }));
    fireEvent.click(screen.getByRole("button", { name: "선택 해제" }));
    expect(useDraftStore.getState().byPage["spawnWorker:app"]).toEqual({ text: "task", images: [], label: "ABC-7" });
    first.unmount();
    useDraftStore.getState().setSpawnDraft_("app", "task", "ABC-7", source);
    render(page("app", { integrations, searchSource: async () => [] }));
    fireEvent.click(screen.getByText("GitHub"));
    expect(useDraftStore.getState().byPage["spawnWorker:app"]?.source).toBeUndefined();
  });

  it("text fields carry no inline outline override (focus styling comes from CSS)", () => {
    render(page("app"));
    expect(screen.getByPlaceholderText(/Ctrl\+Enter/).getAttribute("style") ?? "").not.toContain("outline");
  });
});
