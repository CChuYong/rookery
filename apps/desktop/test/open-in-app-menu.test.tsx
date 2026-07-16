import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { OpenInAppMenu, openInMenuPosition } from "../src/renderer/components/OpenInAppMenu.js";
import { useToastStore } from "../src/renderer/store/toasts.js";

function stub(over: Record<string, unknown> = {}) {
  const apps = {
    list: vi.fn(async () => [
      { id: "vscode", name: "VS Code", kind: "editor", icon: "data:image/png;base64,AAA" },
      { id: "cursor", name: "Cursor", kind: "editor", icon: null },
      { id: "finder", name: "Finder", kind: "finder", icon: null },
    ]),
    open: vi.fn(async () => ({ ok: true })),
  };
  const ws = { resolveRoot: vi.fn(async () => "/code/proj") };
  (window as unknown as { rookery: unknown }).rookery = { apps, ws, ...over };
  return { apps, ws };
}

describe("OpenInAppMenu (split button)", () => {
  beforeEach(() => { localStorage.clear(); useToastStore.setState({ toasts: [] }); stub(); });

  it("detects apps on mount and defaults the left button to the first app", async () => {
    const { apps } = stub();
    render(<OpenInAppMenu subId="w1" />);
    await waitFor(() => expect(apps.list).toHaveBeenCalledTimes(1));
    // Default selection = first item in the list (VS Code) -> reflected in the left button title
    await waitFor(() => expect(screen.getByLabelText("현재 폴더를 앱에서 열기")).toHaveAttribute("title", "VS Code에서 열기"));
  });

  it("left button launches the selected app at the resolved root (no dropdown)", async () => {
    const { apps, ws } = stub();
    render(<OpenInAppMenu subId="w1" />);
    await waitFor(() => expect(screen.getByLabelText("현재 폴더를 앱에서 열기")).toHaveAttribute("title", "VS Code에서 열기"));
    fireEvent.click(screen.getByLabelText("현재 폴더를 앱에서 열기"));
    expect(ws.resolveRoot).toHaveBeenCalledWith({ subId: "w1", cwd: undefined });
    await waitFor(() => expect(apps.open).toHaveBeenCalledWith("vscode", "/code/proj"));
  });

  it("does not render a path line", async () => {
    render(<OpenInAppMenu cwd="/sess/cwd" />);
    fireEvent.click(screen.getByLabelText("다른 앱 선택"));
    await waitFor(() => expect(screen.getByText("VS Code")).toBeInTheDocument());
    expect(screen.queryByText(/\/code\/proj|…\//)).not.toBeInTheDocument();
  });

  it("chevron toggles the dropdown and marks the selected app", async () => {
    render(<OpenInAppMenu />);
    fireEvent.click(screen.getByLabelText("다른 앱 선택"));
    await waitFor(() => expect(screen.getByText("Cursor")).toBeInTheDocument());
    expect(screen.getByText("Finder")).toBeInTheDocument();
  });

  it("portals the dropdown outside the clipping workspace header and positions it below the trigger", async () => {
    const { container } = render(<div className="workspace-header"><OpenInAppMenu /></div>);
    const trigger = screen.getByLabelText("다른 앱 선택");
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      x: 780, y: 20, left: 780, top: 20, right: 900, bottom: 44, width: 120, height: 24,
      toJSON: () => ({}),
    });

    fireEvent.click(trigger);
    const menu = await screen.findByRole("menu");

    expect(menu.parentElement).toBe(document.body);
    expect(container).not.toContainElement(menu);
    expect(menu).toHaveClass("fixed");
    expect(menu).toHaveStyle({ top: "48px", right: `${window.innerWidth - 900}px` });
  });

  it("picking from the dropdown persists the choice to localStorage and launches it", async () => {
    const { apps } = stub();
    render(<OpenInAppMenu cwd="/sess/cwd" />);
    fireEvent.click(screen.getByLabelText("다른 앱 선택"));
    await waitFor(() => expect(screen.getByText("Cursor")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Cursor"));
    await waitFor(() => expect(apps.open).toHaveBeenCalledWith("cursor", "/code/proj"));
    expect(localStorage.getItem("rookery.openInApp")).toBe("cursor");
    expect(screen.queryByText("Finder")).not.toBeInTheDocument(); // closed
    // Left button now switches to Cursor
    await waitFor(() => expect(screen.getByLabelText("현재 폴더를 앱에서 열기")).toHaveAttribute("title", "Cursor에서 열기"));
  });

  it("restores the remembered app from localStorage on mount", async () => {
    localStorage.setItem("rookery.openInApp", "finder");
    render(<OpenInAppMenu />);
    await waitFor(() => expect(screen.getByLabelText("현재 폴더를 앱에서 열기")).toHaveAttribute("title", "Finder에서 열기"));
  });

  it("hides itself when no apps are detected", async () => {
    const { apps } = stub({ apps: { list: vi.fn(async () => []), open: vi.fn() } });
    void apps;
    const { container } = render(<OpenInAppMenu />);
    await waitFor(() => expect(container.querySelector("button")).toBeNull());
  });
});

describe("openInMenuPosition", () => {
  it("keeps the menu inside the viewport gutter and caps its available height", () => {
    expect(openInMenuPosition({ bottom: 44, right: 1190 }, { width: 1200, height: 180 })).toEqual({
      top: 48,
      right: 10,
      maxHeight: 124,
    });
    expect(openInMenuPosition({ bottom: 44, right: 1300 }, { width: 1200, height: 800 }).right).toBe(8);
  });
});

// Previously both a thrown rejection and a resolved {ok:false} were swallowed silently (#11) — a failed
// "open in app" click looked identical to a successful one.
describe("OpenInAppMenu failure feedback (#11)", () => {
  beforeEach(() => { localStorage.clear(); useToastStore.setState({ toasts: [] }); });

  it("toasts openFailed when resolveRoot rejects", async () => {
    stub({ ws: { resolveRoot: vi.fn(async () => { throw new Error("boom"); }) } });
    render(<OpenInAppMenu subId="w1" />);
    await waitFor(() => expect(screen.getByLabelText("현재 폴더를 앱에서 열기")).toHaveAttribute("title", "VS Code에서 열기"));
    fireEvent.click(screen.getByLabelText("현재 폴더를 앱에서 열기"));
    await waitFor(() => expect(useToastStore.getState().toasts.some((t) => t.text === "폴더를 열 수 없어요")).toBe(true));
  });

  it("toasts openFailed when apps.open resolves { ok: false }", async () => {
    stub({ apps: { list: vi.fn(async () => [{ id: "vscode", name: "VS Code", kind: "editor", icon: null }]), open: vi.fn(async () => ({ ok: false, error: "ENOENT" })) } });
    render(<OpenInAppMenu subId="w1" />);
    await waitFor(() => expect(screen.getByLabelText("현재 폴더를 앱에서 열기")).toHaveAttribute("title", "VS Code에서 열기"));
    fireEvent.click(screen.getByLabelText("현재 폴더를 앱에서 열기"));
    await waitFor(() => expect(useToastStore.getState().toasts.some((t) => t.text === "폴더를 열 수 없어요")).toBe(true));
  });

  it("does not toast on a successful open", async () => {
    const { apps } = stub();
    render(<OpenInAppMenu subId="w1" />);
    await waitFor(() => expect(screen.getByLabelText("현재 폴더를 앱에서 열기")).toHaveAttribute("title", "VS Code에서 열기"));
    fireEvent.click(screen.getByLabelText("현재 폴더를 앱에서 열기"));
    await waitFor(() => expect(apps.open).toHaveBeenCalled());
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });
});

// audit #59: the icon+chevron split button was unlabeled — add a short text label.
describe("OpenInAppMenu label (audit #59)", () => {
  it("shows a short 'Open in' text label next to the chevron", async () => {
    render(<OpenInAppMenu />);
    await waitFor(() => expect(screen.getByText("열기")).toBeInTheDocument());
  });
});

// audit #60: role=menu but no initial focus / arrow roving — ContextMenu's precedent reused here.
describe("OpenInAppMenu keyboard nav (audit #60)", () => {
  it("focuses the first app in the dropdown on open", async () => {
    render(<OpenInAppMenu />);
    fireEvent.click(screen.getByLabelText("다른 앱 선택"));
    await waitFor(() => expect(screen.getByText("VS Code").closest('[role="menuitemradio"]')).toHaveFocus());
  });

  it("ArrowDown/ArrowUp roves between apps", async () => {
    render(<OpenInAppMenu />);
    fireEvent.click(screen.getByLabelText("다른 앱 선택"));
    await waitFor(() => expect(screen.getByText("VS Code").closest('[role="menuitemradio"]')).toHaveFocus());
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    expect(screen.getByText("Cursor").closest('[role="menuitemradio"]')).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowUp" });
    expect(screen.getByText("VS Code").closest('[role="menuitemradio"]')).toHaveFocus();
  });
});
