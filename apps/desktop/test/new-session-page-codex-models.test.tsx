import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, act } from "@testing-library/react";
import { NewSessionPage } from "../src/renderer/components/NewSessionPage.js";
import { useStore } from "../src/renderer/store/store.js";
import type { CodexModelInfo } from "@daemon/protocol/messages.js";

// Codex Model Picker Task 3 — direct template is WorkerSpawnModal's equivalent describe block
// (test/worker-spawn-modal.test.tsx). useT falls back to ko when no I18nProvider is mounted, so
// labels below are the ko strings (see composer.ts / workerSpawnModal.ts locale files).
const CODEX_MODELS: CodexModelInfo[] = [
  { id: "gpt-5.5", displayName: "GPT-5.5", defaultEffort: "xhigh", supportedEfforts: ["low", "medium", "high", "xhigh"], isDefault: true },
  { id: "gpt-5.4", displayName: "GPT-5.4", defaultEffort: "medium", supportedEfforts: ["low", "medium", "high"], isDefault: false },
];

const MODEL_TITLE = "모델 (이 대화에만 적용 — 기본 설정과 무관)"; // composer.modelTitle
const EFFORT_TITLE = "effort (이 대화에만 적용)"; // composer.effortTitle

describe("NewSessionPage codex model+effort dropdown (Codex Model Picker Task 3)", () => {
  beforeEach(() => {
    useStore.setState({ codexModels: null }); // reset the singleton store before each test
  });

  it("codexModels seeded → the codex model field is a <Select> listing the catalog (displayName options)", () => {
    useStore.getState().setCodexModels(CODEX_MODELS);
    render(<NewSessionPage repos={[]} defaultModel="claude-opus-4-8" defaultEffort="high" onStart={() => {}} codexDefaultModel="gpt-5.5" />);
    fireEvent.change(screen.getByTitle("에이전트 백엔드"), { target: { value: "codex" } });

    const modelField = screen.getByTitle(MODEL_TITLE);
    expect(modelField.tagName).toBe("SELECT");
    expect(screen.getByText("GPT-5.5")).toBeInTheDocument();
    expect(screen.getByText("GPT-5.4")).toBeInTheDocument();
  });

  it("selecting a codex model updates the effort <Select>'s options to that model's supportedEfforts and pre-selects its defaultEffort", () => {
    useStore.getState().setCodexModels(CODEX_MODELS);
    render(<NewSessionPage repos={[]} defaultModel="claude-opus-4-8" defaultEffort="high" onStart={() => {}} codexDefaultModel="gpt-5.5" />);
    fireEvent.change(screen.getByTitle("에이전트 백엔드"), { target: { value: "codex" } });

    const modelField = screen.getByTitle(MODEL_TITLE);
    fireEvent.change(modelField, { target: { value: "gpt-5.4" } });

    const effortSelect = screen.getByTitle(EFFORT_TITLE) as HTMLSelectElement;
    expect(effortSelect.value).toBe("medium"); // gpt-5.4's defaultEffort
    expect(within(effortSelect).queryByText("매우 높음")).toBeNull(); // xhigh not in gpt-5.4's supportedEfforts

    fireEvent.change(modelField, { target: { value: "gpt-5.5" } });
    expect((screen.getByTitle(EFFORT_TITLE) as HTMLSelectElement).value).toBe("xhigh"); // gpt-5.5's defaultEffort
  });

  it("codexModels null → the codex model field stays the free-text <Input> and effort shows the generic EFFORTS list", () => {
    render(<NewSessionPage repos={[]} defaultModel="claude-opus-4-8" defaultEffort="high" onStart={() => {}} codexDefaultModel="gpt-5.5" />);
    fireEvent.change(screen.getByTitle("에이전트 백엔드"), { target: { value: "codex" } });

    const modelField = screen.getByTitle(MODEL_TITLE);
    expect(modelField.tagName).toBe("INPUT");
    const effortSelect = screen.getByTitle(EFFORT_TITLE) as HTMLSelectElement;
    expect(within(effortSelect).getByText("매우 높음")).toBeInTheDocument(); // generic EFFORTS includes xhigh regardless of model
    expect(within(effortSelect).getByText("최대")).toBeInTheDocument(); // generic EFFORTS includes max (codex catalogs never do)
  });

  it("an out-of-list current codex model value (typed as free text while the catalog was still loading) is preserved as a selectable option once the catalog arrives", () => {
    render(<NewSessionPage repos={[]} defaultModel="claude-opus-4-8" defaultEffort="high" onStart={() => {}} codexDefaultModel="gpt-5.5" />);
    fireEvent.change(screen.getByTitle("에이전트 백엔드"), { target: { value: "codex" } });
    fireEvent.change(screen.getByTitle(MODEL_TITLE), { target: { value: "gpt-preview" } }); // not in CODEX_MODELS

    act(() => { useStore.getState().setCodexModels(CODEX_MODELS); });

    const modelField = screen.getByTitle(MODEL_TITLE) as HTMLSelectElement;
    expect(modelField.tagName).toBe("SELECT");
    expect(within(modelField).getByText("gpt-preview")).toBeInTheDocument();
    expect(modelField.value).toBe("gpt-preview");
  });

  it("onStart carries the dropdown-selected codex model + its pre-selected default effort", () => {
    useStore.getState().setCodexModels(CODEX_MODELS);
    const onStart = vi.fn();
    render(<NewSessionPage repos={[]} defaultModel="claude-opus-4-8" defaultEffort="high" onStart={onStart} codexDefaultModel="gpt-5.5" />);
    fireEvent.change(screen.getByTitle("에이전트 백엔드"), { target: { value: "codex" } });
    fireEvent.change(screen.getByTitle(MODEL_TITLE), { target: { value: "gpt-5.4" } });
    fireEvent.click(screen.getByLabelText("시작")); // newSessionPage.sendLabel (ko)
    expect(onStart.mock.calls[0]![0].model).toBe("gpt-5.4");
    expect(onStart.mock.calls[0]![0].effort).toBe("medium"); // gpt-5.4's defaultEffort
    expect(onStart.mock.calls[0]![0].provider).toBe("codex");
  });

  it("codexModels null — onStart still carries the typed free-text model + the passed-in default effort", () => {
    const onStart = vi.fn();
    render(<NewSessionPage repos={[]} defaultModel="claude-opus-4-8" defaultEffort="high" onStart={onStart} codexDefaultModel="gpt-5.5" />);
    fireEvent.change(screen.getByTitle("에이전트 백엔드"), { target: { value: "codex" } });
    fireEvent.change(screen.getByPlaceholderText("gpt-5.5"), { target: { value: "gpt-6" } });
    fireEvent.click(screen.getByLabelText("시작"));
    expect(onStart.mock.calls[0]![0].model).toBe("gpt-6");
    expect(onStart.mock.calls[0]![0].effort).toBe("high"); // unchanged — no catalog to pre-select from
    expect(onStart.mock.calls[0]![0].provider).toBe("codex");
  });

  // ── Task 4 fold-in (Task 3 review Minor #1): the leading "" option so a fresh open doesn't render blank ──
  it("a fresh open (codexModel still \"\") shows a non-blank leading default option labelled with codexDefaultModel", () => {
    useStore.getState().setCodexModels(CODEX_MODELS);
    render(<NewSessionPage repos={[]} defaultModel="claude-opus-4-8" defaultEffort="high" onStart={() => {}} codexDefaultModel="gpt-5.5" />);
    fireEvent.change(screen.getByTitle("에이전트 백엔드"), { target: { value: "codex" } });

    const modelField = screen.getByTitle(MODEL_TITLE) as HTMLSelectElement;
    expect(modelField.value).toBe(""); // unchanged: still defaults to "" (no auto-pick from the catalog)
    // the "" option's visible label is the codexDefaultModel placeholder text, not a blank string
    expect(modelField.options[0]!.value).toBe("");
    expect(modelField.options[0]!.textContent).toBe("gpt-5.5");
  });
});
