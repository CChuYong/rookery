import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Composer } from "../src/renderer/components/Composer.js";
import { useStore } from "../src/renderer/store/store.js";
import { I18nProvider } from "../src/renderer/i18n/provider.js";

const controls = { provider: "codex", model: "gpt-5.5", editable: true, onSpeed: vi.fn(), speed: "fast" as const };
const show = (extra = {}) => render(<I18nProvider systemLocale="en"><Composer onSend={vi.fn()} controls={{ ...controls, ...extra }} /></I18nProvider>);
beforeEach(() => useStore.getState().setCodexModels(null));
describe("speed intent and observations", () => {
  it("shows requested Fast without inventing effective Fast and changes once", () => {
    const onSpeed = vi.fn();
    show({ onSpeed, speedObservation: { requested: "fast", state: "unknown" } });
    expect(screen.getByLabelText("Speed")).toHaveValue("fast");
    expect(screen.queryByText("Fast requested; effective speed unknown")).toBeNull();
    expect(screen.queryByText("Fast active")).toBeNull();
    fireEvent.change(screen.getByLabelText("Speed"), { target: { value: "standard" } });
    expect(onSpeed).toHaveBeenCalledExactlyOnceWith("standard");
  });
  it("keeps selected unsupported Fast visible but disabled, including the reason", () => {
    useStore.getState().setCodexModels([{ id: "gpt-5.5", displayName: "GPT", defaultEffort: "high", supportedEfforts: [], isDefault: true, serviceTiers: [{ id: "default", name: "Standard", description: "" }] }]);
    show();
    expect(screen.getByLabelText("Speed")).toHaveValue("fast");
    expect(screen.getByRole("option", { name: "Fast" })).toBeDisabled();
    expect(screen.getByLabelText("Speed")).toHaveAttribute("title", "Fast unavailable for this model; preference retained");
  });
  it("missing capability metadata permits Fast without status messages", () => {
    show();
    expect(screen.getByRole("option", { name: "Fast" })).not.toBeDisabled();
    expect(screen.queryByText("Availability unknown")).toBeNull();
    expect(screen.queryByText("Applies next turn")).toBeNull();
    expect(screen.getByLabelText("Speed")).not.toHaveAttribute("title");
  });
  it("keeps pending state out of the composer chrome", () => {
    show({ speed: "standard", speedObservation: { requested: "fast", state: "fast" } });
    expect(screen.queryByText("Applies next turn")).toBeNull();
    expect(screen.queryByText("Fast active")).toBeNull();
  });
  it("makes cooldown and provider reason inspectable", () => {
    show({ speedObservation: { requested: "fast", state: "cooldown", reason: "account cooling down" } });
    expect(screen.queryByText("Fast cooldown")).toBeNull();
    expect(screen.getByLabelText("Speed")).toHaveAttribute("title", expect.stringContaining("account cooling down"));
  });
});

it("configuration invalidation retains historical detail only in the tooltip", () => {
  show({ speedPending: true, speedLastObservation: { requested: "fast", state: "fast", reason: "last turn only" } });
  expect(screen.queryByText("Applies next turn")).toBeNull();
  expect(screen.getByLabelText("Speed")).toHaveAttribute("title", expect.stringContaining("last turn only"));
  expect(screen.queryByText("Last reported: Fast")).toBeNull();
});

it.each([
  { id: "priority", name: "Fast", description: "" },
  { id: "priority", name: "빠르게", description: "" },
  { id: "fast", name: "Fast", description: "" },
])("recognizes catalog tier $id ($name) without relying on its localized label", (tier) => {
  // CLI 0.169.0 reports the Fast capability with id=priority, name=Fast.
  useStore.getState().setCodexModels([{ id: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", defaultEffort: "high", supportedEfforts: ["high"], isDefault: true, serviceTiers: [tier] }]);
  show({ model: "gpt-6.1-sol", speedObservation: { requested: "fast", state: "unknown" } });
  expect(screen.getByRole("option", { name: "Fast" })).not.toBeDisabled();
  expect(screen.queryByText("Fast unavailable for this model; preference retained")).toBeNull();
  expect(screen.queryByText("Fast requested; effective speed unknown")).toBeNull();
});

it("marks a Fast request the provider did not honor with a quiet dot, not inline text", () => {
  show({ speed: "fast", speedObservation: { requested: "fast", state: "cooldown", reason: "account cooling down" } });
  expect(screen.getByRole("img", { name: /different speed/ })).toBeInTheDocument();
  expect(screen.queryByText("Fast cooldown")).toBeNull();
});

it("shows no dot while Fast is honored or the outcome is unknown", () => {
  const { unmount } = show({ speed: "fast", speedObservation: { requested: "fast", state: "fast" } });
  expect(screen.queryByRole("img", { name: /different speed/ })).toBeNull();
  unmount();
  show({ speed: "fast", speedObservation: { requested: "fast", state: "unknown" } });
  expect(screen.queryByRole("img", { name: /different speed/ })).toBeNull();
});
