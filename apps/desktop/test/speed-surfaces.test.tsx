import { beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import appSource from "../src/renderer/App.tsx?raw";
import { NewSessionPage } from "../src/renderer/components/NewSessionPage.js";
import { WorkerSpawnPage } from "../src/renderer/components/WorkerSpawnPage.js";
import { AutomationForm } from "../src/renderer/components/AutomationForm.js";
import { SettingsPage } from "../src/renderer/components/SettingsPage.js";
import { ConversationPane } from "../src/renderer/components/ConversationPane.js";
import { useStore } from "../src/renderer/store/store.js";
import { I18nProvider } from "../src/renderer/i18n/provider.js";
import type { SettingsValues } from "@daemon/core/settings.js";
import type { Automation } from "@daemon/persistence/repositories.js";

const settings = { masterModel: "claude-opus-4-8", workerModel: "claude-opus-4-8", codexMasterModel: "gpt-5.5", codexWorkerModel: "gpt-5.5", masterEffort: "high", workerEffort: "high", masterSpeed: "fast", workerSpeed: "standard", codexMasterSpeed: "standard", codexWorkerSpeed: "fast" } as SettingsValues;
beforeEach(() => useStore.setState({ settings, codexModels: null, workerLogs: {}, logsBySession: {}, pendingBySession: {}, pendingByWorker: {}, sideConversations: {}, running: {}, fleet: {} }));
const english = (child: JSX.Element) => <I18nProvider systemLocale="en">{child}</I18nProvider>;
it("new master inherits each provider default and sends an explicit selection", () => {
  const onStart = vi.fn();
  render(english(<NewSessionPage repos={[]} defaultModel={settings.masterModel} defaultEffort="high" onStart={onStart} />));
  fireEvent.click(screen.getByRole("button", { name: /Model settings/ })); // speed lives in the model menu (audit #85)
  expect(screen.getByLabelText("Speed")).toHaveValue("");
  expect(screen.getByRole("option", { name: "Fast (default)" })).toBeInTheDocument();
  fireEvent.change(screen.getByTitle("Agent backend"), { target: { value: "codex" } });
  expect(screen.getByRole("option", { name: "Standard (default)" })).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Speed"), { target: { value: "fast" } });
  fireEvent.click(screen.getByLabelText("Start"));
  expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ speed: "fast", provider: "codex" }));
});
it("worker spawn carries its own selected preference and labels Codex budgets", () => {
  const onSpawn = vi.fn();
  render(english(<WorkerSpawnPage repo="app" defaultModel={settings.workerModel} defaultEffort="high" onSpawn={onSpawn} onClose={vi.fn()} />));
  fireEvent.change(screen.getByTitle("Agent backend"), { target: { value: "codex" } });
  fireEvent.click(screen.getByRole("button", { name: /Model settings/ })); // speed lives in the model menu, as on the other composers
  expect(screen.getByRole("option", { name: "Fast (default)" })).toBeInTheDocument();
  fireEvent.change(screen.getByRole("combobox", { name: "Speed" }), { target: { value: "standard" } });
  fireEvent.click(screen.getByRole("button", { name: /Spawn|Start/ }));
  expect(onSpawn.mock.calls[0]?.[9]).toBe("standard");
  expect(screen.getByText(/Codex costs and budget checks are estimates/)).toBeInTheDocument();
});
it("automation edit restores selected Fast, preserves it when unsupported, and saves it", async () => {
  const init = { id: "a", name: "daily", enabled: true, provider: "codex", model: "gpt-5.5", speed: "fast", trigger: { kind: "interval", everyMinutes: 10 }, action: { kind: "worker", repo: "app", task: "check" } } as Automation;
  useStore.getState().setCodexModels([{ id: "gpt-5.5", displayName: "GPT", isDefault: true, defaultEffort: "high", supportedEfforts: ["high"], serviceTiers: [{ id: "default", name: "Standard", description: "" }] }]);
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  render(english(<AutomationForm job={init} repos={[{ name: "app", path: "/app" }]} onSubmit={onSubmit} onClose={vi.fn()} />));
  expect(screen.getByLabelText("Speed")).toHaveValue("fast");
  expect(screen.getByLabelText("Speed")).toHaveAttribute("title", expect.stringContaining("Fast unavailable for this model"));
  await act(async () => fireEvent.click(screen.getByText("Save")));
  expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ speed: "fast" }));
});
it("settings edits all four independent defaults", () => {
  const onSave = vi.fn();
  render(english(<SettingsPage settings={settings} onSave={onSave} onClose={vi.fn()} slack="off" onSlackToggle={vi.fn()} />));
  fireEvent.click(screen.getByText("Models"));
  expect(screen.getByLabelText("Master speed")).toHaveValue("fast");
  fireEvent.change(screen.getByLabelText("Master speed"), { target: { value: "standard" } });
  fireEvent.change(screen.getByLabelText("Worker speed"), { target: { value: "fast" } });
  fireEvent.click(screen.getByText("Codex"));
  expect(screen.getByLabelText("Master speed")).toHaveValue("standard");
  expect(screen.getByLabelText("Worker speed")).toHaveValue("fast");
  fireEvent.change(screen.getByLabelText("Master speed"), { target: { value: "fast" } });
  fireEvent.change(screen.getByLabelText("Worker speed"), { target: { value: "standard" } });
  fireEvent.click(screen.getAllByText("Save").at(-1)!);
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ masterSpeed: "standard", workerSpeed: "fast", codexMasterSpeed: "fast", codexWorkerSpeed: "standard" }));
});
it.each(["master", "worker"] as const)("%s composer restores intent; Side reads inherited speed without another setting", async (kind) => {
  useStore.getState().setSessions([{ id: "s", cwd: "/", status: "idle", lastActivity: "", origin: "ui", speed: "fast" }]);
  render(english(<ConversationPane kind={kind} id="s" onSend={vi.fn()} onSideStart={async () => "side"} controls={{ speed: "fast", model: "gpt-5.5", provider: "codex", editable: true, onSpeed: vi.fn() }} />));
  expect(screen.getByLabelText("Speed")).toHaveValue("fast");
  // A replayed Fast report is historical and must not certify the current configuration.
  await act(async () => useStore.getState().seedHistory("s", [{ seq: 1, type: "master.speed", payload: { type: "master.speed", sessionId: "s", observation: { requested: "fast", state: "fast" } } }]));
  expect(screen.queryByText("Fast active")).toBeNull();
  expect(screen.queryByText("Last reported: Fast")).toBeNull();
  // /side action reaches the same drawer path as the Side button.
  const editor = document.querySelector("[contenteditable=true]") as HTMLElement;
  const { setPromptEditorText } = await import("./prompt-editor-helpers.js");
  setPromptEditorText(editor, "explain");
  fireEvent.click(screen.getByRole("button", { name: "Side question" }));
  await waitFor(() => expect(screen.getByText("Inherited: Fast")).toBeInTheDocument());
  expect(screen.getAllByLabelText("Speed")).toHaveLength(1);
});
it("both App workspace branches use the same speed-aware controls", () => {
  const source = appSource;
  expect(source.match(/controls=\{workerControls\}/g)).toHaveLength(2);
  expect(source.match(/controls=\{masterControls\}/g)).toHaveLength(2);
  expect(source).toContain('setTargetSpeed("master"');
  expect(source).toContain('setTargetSpeed("worker"');
  expect(source).toContain('speed: opts.speed');
});
