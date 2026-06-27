import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WorkerHeader } from "../src/renderer/components/WorkspaceHeaders.js";
import { I18nProvider } from "../src/renderer/i18n/provider.js";
import { usePrefsStore } from "../src/renderer/store/prefs.js";

const baseProps = {
  termPageKey: null, termPageOpen: false, rightOpen: false,
  onToggleTerm: () => {}, onToggleRight: () => {},
  onFetchCheckpoints: async () => [], onRestore: () => {},
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
