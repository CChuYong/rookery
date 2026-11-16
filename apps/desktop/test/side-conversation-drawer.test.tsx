import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { createPortal } from "react-dom";
import { useStore } from "../src/renderer/store/store.js";

// A portaled modal rendered by something inside the drawer (the image lightbox in real use): React bubbles its keydown
// through the component tree to the drawer even though it is outside the drawer's DOM.
const modal = vi.hoisted(() => ({ open: true }));
vi.mock("../src/renderer/components/MessageList.js", () => ({
  MessageList: () => (modal.open ? createPortal(<div role="dialog" aria-modal="true"><button>lightbox close</button></div>, document.body) : null),
}));

const { SideConversationDrawer } = await import("../src/renderer/components/SideConversationDrawer.js");

describe("SideConversationDrawer Escape (fix round 1)", () => {
  beforeEach(() => useStore.setState({ sideConversations: {} } as never));

  it("ignores an Escape from a portaled modal opened inside it, and closes on its own Escape", () => {
    const onClose = vi.fn();
    modal.open = true;
    const ui = (): JSX.Element => <SideConversationDrawer sourceKind="master" sourceId="s1" sideId="side-1" openingQuestion="q" onSend={async () => {}} onStop={() => {}} onClose={onClose} />;
    const { rerender } = render(ui());
    fireEvent.keyDown(screen.getByRole("button", { name: "lightbox close" }), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    modal.open = false; // the modal closed
    rerender(ui());
    fireEvent.keyDown(screen.getByRole("button", { name: "닫기" }), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
