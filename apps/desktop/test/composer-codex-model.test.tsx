import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Composer } from "../src/renderer/components/Composer.js";
import { useStore } from "../src/renderer/store/store.js";

// The live-conversation Composer (master session + running worker) must source its model dropdown from the
// codex model/list catalog when the conversation runs on codex — the same parity the spawn/new-session pickers
// got. These tests pin the two reported bugs: (1) a codex conversation showing Claude models, (2) the worker
// dropdown listing Claude options while gpt-5.5 is selected.
const CODEX = [
  { id: "gpt-5.5", displayName: "GPT-5.5", defaultEffort: "xhigh", supportedEfforts: ["low", "medium", "high", "xhigh"], isDefault: true },
  { id: "gpt-5.4", displayName: "GPT-5.4", defaultEffort: "medium", supportedEfforts: ["low", "medium", "high", "xhigh"], isDefault: false },
];
const MODEL_TITLE = /모델|Model/;

describe("Composer codex model/effort (codex-aware controls)", () => {
  beforeEach(() => useStore.getState().setCodexModels(null));

  it("provider=codex + codexModels set → model dropdown lists the codex catalog (displayName), not Claude", () => {
    useStore.getState().setCodexModels(CODEX);
    render(<Composer onSend={() => {}} controls={{ provider: "codex", model: "gpt-5.5", effort: "xhigh", editable: true, onModel: () => {}, onEffort: () => {} }} />);
    const model = screen.getByTitle(MODEL_TITLE) as HTMLSelectElement;
    expect(model.value).toBe("gpt-5.5");
    expect(screen.getByRole("option", { name: "GPT-5.5" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "GPT-5.4" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Opus|Sonnet|Haiku/ })).toBeNull(); // no Claude models leak in
  });

  it("codex effort options are the selected model's efforts (no `max`), and switching model pre-selects its default effort", () => {
    useStore.getState().setCodexModels(CODEX);
    const onModel = vi.fn();
    const onEffort = vi.fn();
    render(<Composer onSend={() => {}} controls={{ provider: "codex", model: "gpt-5.5", effort: "xhigh", editable: true, onModel, onEffort }} />);
    // gpt-5.5's efforts don't include the Claude-only `max`
    expect(screen.queryByRole("option", { name: /^max$/i })).toBeNull();
    fireEvent.change(screen.getByTitle(MODEL_TITLE), { target: { value: "gpt-5.4" } });
    expect(onModel).toHaveBeenCalledWith("gpt-5.4");
    expect(onEffort).toHaveBeenCalledWith("medium"); // gpt-5.4's defaultReasoningEffort
  });

  it("provider=codex but codexModels null (catalog unfetched) → falls back to the Claude models list, keeping the current value", () => {
    render(<Composer onSend={() => {}} controls={{ provider: "codex", model: "gpt-5.5", effort: "high", editable: true, onModel: () => {}, onEffort: () => {} }} />);
    const model = screen.getByTitle(MODEL_TITLE) as HTMLSelectElement;
    expect(screen.getByRole("option", { name: /Opus/ })).toBeInTheDocument(); // Claude fallback
    expect(model.value).toBe("gpt-5.5"); // current codex value preserved as an out-of-list option
  });

  it("provider=claude → Claude models even when a codex catalog is loaded", () => {
    useStore.getState().setCodexModels(CODEX);
    render(<Composer onSend={() => {}} controls={{ provider: "claude", model: "claude-opus-4-8", effort: "high", editable: true, onModel: () => {}, onEffort: () => {} }} />);
    expect(screen.getByRole("option", { name: /Opus/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "GPT-5.5" })).toBeNull();
  });

  it("read-only worker badge (editable=false) labels the codex model by its displayName", () => {
    useStore.getState().setCodexModels(CODEX);
    render(<Composer onSend={() => {}} controls={{ provider: "codex", model: "gpt-5.5", editable: false }} />);
    expect(screen.getByText(/GPT-5.5/)).toBeInTheDocument();
  });
});
