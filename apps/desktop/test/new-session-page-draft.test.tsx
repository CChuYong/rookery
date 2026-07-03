import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NewSessionPage, NEW_SESSION_DRAFT_KEY } from "../src/renderer/components/NewSessionPage.js";
import { useDraftStore, emptyDraftState } from "../src/renderer/store/drafts.js";

// Audit #5: the New Session composer must wire into the drafts store under the fixed "newSession" key —
// exactly like ConversationPane does per-session — so a typed-but-unsent prompt survives page close/reopen
// and a failed session.create (App.tsx restores the draft in startSession's catch).
describe("NewSessionPage draft persistence (audit #5)", () => {
  beforeEach(() => {
    useDraftStore.setState(emptyDraftState());
  });

  it("seeds the composer from a previously restored newSession draft", () => {
    useDraftStore.getState().setDraft_(NEW_SESSION_DRAFT_KEY, "unsent prompt");
    render(<NewSessionPage repos={[]} defaultModel="claude-opus-4-8" defaultEffort="high" onStart={() => {}} />);
    const ed = screen.getByRole("textbox");
    expect(ed.textContent).toBe("unsent prompt");
  });

  it("writes typed input back into the newSession draft key as the user types", () => {
    render(<NewSessionPage repos={[]} defaultModel="claude-opus-4-8" defaultEffort="high" onStart={() => {}} />);
    const ed = screen.getByRole("textbox");
    ed.textContent = "typing a prompt";
    fireEvent.input(ed);
    expect(useDraftStore.getState().byPage[NEW_SESSION_DRAFT_KEY]).toBe("typing a prompt");
  });
});
