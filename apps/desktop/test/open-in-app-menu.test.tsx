import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { OpenInAppMenu } from "../src/renderer/components/OpenInAppMenu.js";

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
  beforeEach(() => { localStorage.clear(); stub(); });

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
