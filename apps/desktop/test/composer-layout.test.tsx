import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import { Composer } from "../src/renderer/components/Composer.js";
import { useStore } from "../src/renderer/store/store.js";
import { setPromptEditorText } from "./prompt-editor-helpers.js";

// Audit #85/#29/#33/#32/#116: the composer footer is one row — model, effort, permission and speed fold into one
// model menu; the icon buttons explain themselves (and why they are disabled); a failed send reports once, inline.
beforeEach(() => useStore.getState().setCodexModels(null));

const master = { model: "claude-opus-4-8", effort: "high", permissionMode: "bypassPermissions", editable: true, onModel: vi.fn(), onEffort: vi.fn(), onPermissionMode: vi.fn(), speed: null, defaultSpeed: "standard" as const, onSpeed: vi.fn() };

describe("Composer model menu", () => {
  it("summarises model · effort on one quiet trigger and keeps the selectors in its menu", () => {
    render(<Composer onSend={() => {}} controls={master} />);
    const trigger = screen.getByRole("button", { name: /Opus 4\.8 · 높음/ });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    // closed: no selector is exposed in the footer
    expect(screen.queryAllByRole("combobox")).toHaveLength(0);
    fireEvent.click(trigger);
    const menu = screen.getByRole("dialog");
    expect(within(menu).getAllByRole("combobox")).toHaveLength(4); // model, effort, permission, speed
    fireEvent.keyDown(within(menu).getAllByRole("combobox")[0]!, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("shows only non-default permission and speed choices on the trigger", () => {
    const { rerender } = render(<Composer onSend={() => {}} controls={master} />);
    expect(screen.queryByRole("button", { name: /Bypass/ })).toBeNull(); // the default mode is not shouted on the bar
    rerender(<Composer onSend={() => {}} controls={{ ...master, permissionMode: "plan", speed: "fast" }} />);
    expect(screen.getByRole("button", { name: /Opus 4\.8 · 높음 · Plan Mode · Fast/ })).toBeInTheDocument();
  });

  it("keeps the send button in the right-hand action group with the model trigger (never wraps alone)", () => {
    render(<Composer onSend={() => {}} controls={master} />);
    const send = screen.getByRole("button", { name: "보내기" });
    const actions = send.closest("[data-composer-actions]");
    expect(actions).not.toBeNull();
    expect(send.className).toContain("shrink-0");
    expect(within(actions as HTMLElement).getByRole("button", { name: /Opus 4\.8/ })).toBeInTheDocument();
  });
});

describe("Composer icon buttons explain themselves", () => {
  it("send and side question carry tooltips that say why they are disabled", () => {
    render(<Composer onSend={() => {}} onSideSend={() => {}} />);
    const tips = screen.getAllByRole("tooltip", { hidden: true }).map((tip) => tip.textContent);
    expect(tips).toContain("보낼 메시지를 입력하세요");
    expect(tips).toContain("질문을 입력하면 메인 작업을 멈추지 않고 따로 물어볼 수 있어요 (/side)");
    expect(screen.getByRole("button", { name: "Side 질문" })).toBeDisabled();
  });

  it("with text the tooltips name the action", () => {
    render(<Composer onSend={() => {}} onSideSend={() => {}} />);
    setPromptEditorText(screen.getByRole("textbox"), "hi");
    const tips = screen.getAllByRole("tooltip", { hidden: true }).map((tip) => tip.textContent);
    expect(tips).toContain("보내기");
    expect(tips).toContain("메인 작업을 멈추지 않고 따로 물어봐요 (/side)");
  });
});

describe("Composer send feedback", () => {
  it("spins the send button while the send is in flight", async () => {
    let release!: () => void;
    const send = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    render(<Composer onSend={send} initialText="go" />);
    fireEvent.click(screen.getByRole("button", { name: "보내기" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "보내기" })).toHaveAttribute("aria-busy", "true"));
    await act(async () => release());
    expect(screen.getByRole("button", { name: "보내기" })).not.toHaveAttribute("aria-busy");
  });

  it("reports a failed text send once, inline, with the reason (not the image copy)", async () => {
    const send = vi.fn().mockRejectedValue(new Error("not connected"));
    render(<Composer onSend={send} initialText="hello" />);
    fireEvent.click(screen.getByRole("button", { name: "보내기" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("보내지 못했어요: not connected");
    expect(screen.getByRole("textbox")).toHaveTextContent("hello");
  });
});

// Audit #117: a read-only composer at rest (ended worker, Slack session) has no dead input buttons.
describe("Composer read-only at rest", () => {
  it("hides send and attach while disabled and idle, keeping the placeholder and the model badge", () => {
    render(<Composer onSend={() => {}} onAttachFile={async () => null} disabled placeholder="Worker ended — view only" controls={{ model: "claude-opus-4-8", editable: false }} />);
    expect(screen.queryByRole("button", { name: "보내기" })).toBeNull();
    expect(screen.queryByRole("button", { name: "파일 첨부" })).toBeNull();
    expect(screen.getByText("Worker ended — view only")).toBeInTheDocument();
    expect(screen.getByText("Opus 4.8")).toBeInTheDocument();
  });
});
