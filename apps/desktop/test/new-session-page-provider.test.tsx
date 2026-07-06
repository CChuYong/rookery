import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NewSessionPage } from "../src/renderer/components/NewSessionPage.js";

// P2.5 Task 4 (Track D): new-session provider selector — direct template is
// WorkerSpawnModal's provider-selector describe block (test/worker-spawn-modal.test.tsx).
// useT falls back to ko when no I18nProvider is mounted, so labels below are the ko strings.
describe("NewSessionPage provider selector (P2.5 task 4)", () => {
  it("defaults to claude — onStart's provider is undefined (wire-minimal)", () => {
    const onStart = vi.fn();
    render(<NewSessionPage repos={[]} defaultModel="claude-opus-4-8" defaultEffort="high" onStart={onStart} />);
    fireEvent.click(screen.getByLabelText("시작")); // newSessionPage.sendLabel (ko)
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStart.mock.calls[0]![0].provider).toBeUndefined();
  });

  it("selecting codex passes provider \"codex\" to onStart", () => {
    const onStart = vi.fn();
    render(<NewSessionPage repos={[]} defaultModel="claude-opus-4-8" defaultEffort="high" onStart={onStart} codexDefaultModel="gpt-5.5" />);
    fireEvent.change(screen.getByTitle("에이전트 백엔드"), { target: { value: "codex" } });
    fireEvent.click(screen.getByLabelText("시작"));
    expect(onStart.mock.calls[0]![0].provider).toBe("codex");
  });

  it("switching to codex swaps the model control for a free-text input with the codexDefaultModel placeholder", () => {
    render(<NewSessionPage repos={[]} defaultModel="claude-opus-4-8" defaultEffort="high" onStart={() => {}} codexDefaultModel="gpt-5.5" />);
    // Claude mode: the model field is the shared Composer's own native <select> (the Claude model catalog).
    const claudeModelSelect = screen.getByTitle("모델 (이 대화에만 적용 — 기본 설정과 무관)");
    expect(claudeModelSelect.tagName).toBe("SELECT");

    fireEvent.change(screen.getByTitle("에이전트 백엔드"), { target: { value: "codex" } });

    // The Composer's own model <select> is gone (its `controls` prop is omitted for codex); the same-titled
    // element is now NewSessionPage's own free-text <input> with the codexDefaultModel placeholder.
    const codexModelField = screen.getByTitle("모델 (이 대화에만 적용 — 기본 설정과 무관)");
    expect(codexModelField.tagName).toBe("INPUT");
    expect(codexModelField).toHaveAttribute("placeholder", "gpt-5.5");
  });

  it("the codex free-text model field's typed text flows through to onStart.model", () => {
    const onStart = vi.fn();
    render(<NewSessionPage repos={[]} defaultModel="claude-opus-4-8" defaultEffort="high" onStart={onStart} codexDefaultModel="gpt-5.5" />);
    fireEvent.change(screen.getByTitle("에이전트 백엔드"), { target: { value: "codex" } });
    const modelField = screen.getByPlaceholderText("gpt-5.5");
    fireEvent.change(modelField, { target: { value: "gpt-6-mini" } });
    fireEvent.click(screen.getByLabelText("시작"));
    expect(onStart.mock.calls[0]![0].model).toBe("gpt-6-mini");
    expect(onStart.mock.calls[0]![0].provider).toBe("codex");
  });

  it("effort remains selectable for codex (not special-cased/hidden)", () => {
    render(<NewSessionPage repos={[]} defaultModel="claude-opus-4-8" defaultEffort="high" onStart={() => {}} codexDefaultModel="gpt-5.5" />);
    fireEvent.change(screen.getByTitle("에이전트 백엔드"), { target: { value: "codex" } });
    const effortSelect = screen.getByTitle("effort (이 대화에만 적용)");
    expect(effortSelect.tagName).toBe("SELECT");
    fireEvent.change(effortSelect, { target: { value: "xhigh" } });
    expect((effortSelect as HTMLSelectElement).value).toBe("xhigh");
  });
});
