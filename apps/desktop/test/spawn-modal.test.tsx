import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { WorkerSpawnModal } from "../src/renderer/components/WorkerSpawnModal.js";
import type { SourceItem } from "@daemon/core/source-intake.js";

describe("WorkerSpawnModal", () => {
  it("defaults to direct-write mode (no search box) and passes base through onSpawn", () => {
    const onSpawn = vi.fn();
    render(<WorkerSpawnModal repo="app" defaultModel="claude-opus-4-8" defaultEffort="high" branches={["main", "dev"]} onSpawn={onSpawn} onClose={() => {}} />);
    // Direct-write mode: no search box
    expect(screen.queryByPlaceholderText(/검색/)).toBeNull();
    fireEvent.change(screen.getByTitle(/base 브랜치/), { target: { value: "dev" } });
    fireEvent.change(screen.getByPlaceholderText(/Ctrl\+Enter/), { target: { value: "do it" } });
    fireEvent.click(screen.getByText("spawn"));
    expect(onSpawn).toHaveBeenCalledWith("do it", "", "claude-opus-4-8", "high", "dev", undefined, "bypassPermissions"); // no ticket → undefined; default permission
  });

  it("defaults permission to bypassPermissions and threads the selected mode (plan) through onSpawn", () => {
    const onSpawn = vi.fn();
    render(<WorkerSpawnModal repo="app" defaultModel="claude-opus-4-8" defaultEffort="high" onSpawn={onSpawn} onClose={() => {}} />);
    const sel = screen.getByTitle(/권한 모드|Permission mode/) as HTMLSelectElement;
    expect(sel.value).toBe("bypassPermissions");
    // restricted to bypass + plan (no default/acceptEdits)
    expect(screen.getByText("Plan Mode")).toBeInTheDocument();
    expect(screen.queryByText("Accept Edits")).toBeNull();
    fireEvent.change(sel, { target: { value: "plan" } });
    fireEvent.click(screen.getByText("spawn"));
    expect(onSpawn.mock.calls.at(-1)).toEqual(["", "", "claude-opus-4-8", "high", undefined, undefined, "plan"]);
  });

  it("passes the selected ticket {key,url} to onSpawn", async () => {
    const items: SourceItem[] = [{ provider: "linear", id: "1", identifier: "ABC-7", title: "Ship it", url: "https://l/ABC-7", body: "do it", state: "Todo" }];
    const onSpawn = vi.fn();
    render(<WorkerSpawnModal repo="app" defaultModel="claude-opus-4-8" defaultEffort="high"
      integrations={{ github: { available: false }, linear: { configured: true, valid: true } }}
      searchSource={async () => items} onSpawn={onSpawn} onClose={() => {}} />);
    fireEvent.click(screen.getByText("Linear"));
    const input = screen.getByPlaceholderText(/티켓 검색/);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "ship" } });
    fireEvent.click(await screen.findByText(/ABC-7/));
    await waitFor(() => expect((screen.getByPlaceholderText(/Ctrl\+Enter/) as HTMLTextAreaElement).value).toContain("do it"));
    fireEvent.click(screen.getByText("spawn"));
    expect(onSpawn.mock.calls.at(-1)![5]).toEqual({ key: "ABC-7", url: "https://l/ABC-7" });
  });

  it("disables a source segment when its integration is not connected", () => {
    render(<WorkerSpawnModal repo="app" defaultModel="claude-opus-4-8" defaultEffort="high"
      integrations={{ github: { available: false }, linear: { configured: false } }}
      searchSource={async () => []} onSpawn={() => {}} onClose={() => {}} />);
    expect(screen.getByText("GitHub")).toBeDisabled();
    expect(screen.getByText("Linear")).toBeDisabled();
    expect(screen.getByText("직접 작성")).not.toBeDisabled();
  });

  it("switches to Linear mode, searches, and fills task+label on select", async () => {
    const items: SourceItem[] = [{ provider: "linear", id: "1", identifier: "ABC-7", title: "Ship it", url: "https://l/ABC-7", body: "do it", state: "Todo" }];
    const searchSource = vi.fn(async () => items);
    render(<WorkerSpawnModal repo="app" defaultModel="claude-opus-4-8" defaultEffort="high"
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
    render(<WorkerSpawnModal repo="app" defaultModel="claude-opus-4-8" defaultEffort="high" onSpawn={onSpawn} onClose={() => {}} />);
    // task left empty (default), click spawn
    fireEvent.click(screen.getByText("spawn"));
    expect(onSpawn).toHaveBeenCalledWith("", "", "claude-opus-4-8", "high", undefined, undefined, "bypassPermissions");
  });

  it("non-empty task → spawn button still calls onSpawn with trimmed task", () => {
    const onSpawn = vi.fn();
    render(<WorkerSpawnModal repo="app" defaultModel="claude-opus-4-8" defaultEffort="high" onSpawn={onSpawn} onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/Ctrl\+Enter/), { target: { value: "fix the bug" } });
    fireEvent.click(screen.getByText("spawn"));
    expect(onSpawn).toHaveBeenCalledWith("fix the bug", "", "claude-opus-4-8", "high", undefined, undefined, "bypassPermissions");
  });

  it("shows the results dropdown only while the search box is focused", async () => {
    const items: SourceItem[] = [{ provider: "linear", id: "1", identifier: "ABC-7", title: "Ship it", url: "https://l/ABC-7", body: "do it" }];
    const searchSource = vi.fn(async () => items);
    render(<WorkerSpawnModal repo="app" defaultModel="claude-opus-4-8" defaultEffort="high"
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
