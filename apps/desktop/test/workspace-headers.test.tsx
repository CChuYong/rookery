import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WorkerHeader, SessionHeader } from "../src/renderer/components/WorkspaceHeaders.js";
import { I18nProvider } from "../src/renderer/i18n/provider.js";
import { usePrefsStore } from "../src/renderer/store/prefs.js";
import { useDockPanelsStore } from "../src/renderer/store/dock-panels.js";

const baseProps = {
  termPageKey: null, termPageOpen: false, rightOpen: false,
  onToggleTerm: () => {}, onToggleRight: () => {},
  onFetchCheckpoints: async () => [], onRestore: async () => {},
};

const openExternal = vi.fn();
beforeEach(() => {
  // OpenInAppMenu (header right side) reads window.rookery.apps.list, so mock it too.
  (window as unknown as { rookery: unknown }).rookery = { openExternal, apps: { list: async () => [] } };
});
afterEach(() => { openExternal.mockReset(); delete (window as unknown as { rookery?: unknown }).rookery; });

describe("WorkerHeader ticket link", () => {
  it("renders a ticket button that opens the ticket url externally", () => {
    render(<WorkerHeader {...baseProps} worker={{ id: "w1", label: "t", repoPath: "/r", status: "running", branch: "rookery/eng-1", model: null, ticketKey: "ENG-1", ticketUrl: "https://l/ENG-1" } as never} />);
    fireEvent.click(screen.getByText("ENG-1"));
    expect(openExternal).toHaveBeenCalledWith("https://l/ENG-1");
  });

  it("shows no ticket button when the worker has no ticket", () => {
    render(<WorkerHeader {...baseProps} worker={{ id: "w2", label: "t", repoPath: "/r", status: "running", branch: "rookery/a0", model: null } as never} />);
    expect(screen.queryByText("ENG-1")).toBeNull();
  });
});

describe("WorkerHeader terminology (reserved-word contract)", () => {
  beforeEach(() => { usePrefsStore.setState({ localePref: "system" }); });
  it("labels a worker 'Worker', never the reserved 'Agent'", () => {
    render(
      <I18nProvider systemLocale="en-US">
        <WorkerHeader {...baseProps} worker={{ id: "w3", label: "demo", repoPath: "/r", status: "running", branch: "rookery/a0", model: null } as never} />
      </I18nProvider>,
    );
    expect(screen.queryByText("Agent")).toBeNull();
    expect(screen.getByText("Worker")).toBeInTheDocument();
  });
});

// audit #48: dock mode used to hide the terminal/right-panel header toggles
// entirely. In dock mode they're restored, but now drive dockPanelsStore
// (the actual dockview panel add/remove is WorkspaceDock's job, covered by a
// live check — this only pins that the header wires the right store calls).
describe("HeaderControls dock-mode toggles (audit #48)", () => {
  beforeEach(() => { useDockPanelsStore.setState({ hiddenByPage: {} }); });

  it("SessionHeader (master): legacy toggle buttons are absent in dock mode, dock toggles are present instead", () => {
    render(<SessionHeader {...baseProps} name="s" sessionId="s1" cwd="/r" readOnly={false} running={false} termPageKey="p1" dock />);
    // Both dock buttons share aria-labels with the legacy ones — only one of each should render.
    expect(screen.getAllByLabelText("터미널")).toHaveLength(1);
    expect(screen.getAllByLabelText("우측 패널")).toHaveLength(1);
  });

  it("SessionHeader (master): terminal toggle hides/shows only the terminal panel", () => {
    render(<SessionHeader {...baseProps} name="s" sessionId="s1" cwd="/r" readOnly={false} running={false} termPageKey="p1" dock />);
    fireEvent.click(screen.getByLabelText("터미널"));
    expect(useDockPanelsStore.getState().hiddenByPage.p1).toEqual(["terminal"]);
    fireEvent.click(screen.getByLabelText("터미널"));
    expect(useDockPanelsStore.getState().hiddenByPage.p1).toEqual([]);
  });

  it("SessionHeader (master): right-panel toggle hides/shows files+git as one group (no nested — master pages never seed it)", () => {
    render(<SessionHeader {...baseProps} name="s" sessionId="s1" cwd="/r" readOnly={false} running={false} termPageKey="p1" dock />);
    fireEvent.click(screen.getByLabelText("우측 패널"));
    expect(useDockPanelsStore.getState().hiddenByPage.p1).toEqual(["files", "git"]);
    fireEvent.click(screen.getByLabelText("우측 패널"));
    expect(useDockPanelsStore.getState().hiddenByPage.p1).toEqual([]);
  });

  it("WorkerHeader: right-panel toggle's group includes nested", () => {
    render(<WorkerHeader {...baseProps} termPageKey="w1" dock worker={{ id: "w1", label: "t", repoPath: "/r", status: "running", branch: "rookery/a0", model: null } as never} />);
    fireEvent.click(screen.getByLabelText("우측 패널"));
    expect(useDockPanelsStore.getState().hiddenByPage.w1).toEqual(["files", "git", "nested"]);
  });
});
