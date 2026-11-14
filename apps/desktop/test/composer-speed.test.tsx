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
    expect(screen.getByText("Fast requested; effective speed unknown")).toBeInTheDocument();
    expect(screen.queryByText("Fast active")).toBeNull();
    fireEvent.change(screen.getByLabelText("Speed"), { target: { value: "standard" } });
    expect(onSpeed).toHaveBeenCalledExactlyOnceWith("standard");
  });
  it("keeps selected unsupported Fast visible but disabled, including the reason", () => {
    useStore.getState().setCodexModels([{ id: "gpt-5.5", displayName: "GPT", defaultEffort: "high", supportedEfforts: [], isDefault: true, serviceTiers: [{ id: "default", name: "Standard", description: "" }] }]);
    show();
    expect(screen.getByLabelText("Speed")).toHaveValue("fast");
    expect(screen.getByRole("option", { name: "Fast" })).toBeDisabled();
    expect(screen.getByText("Fast unavailable for this model; preference retained")).toBeInTheDocument();
  });
  it("missing capability metadata permits Fast and explains unknown availability", () => {
    show();
    expect(screen.getByRole("option", { name: "Fast" })).not.toBeDisabled();
    expect(screen.getByText("Availability unknown")).toBeInTheDocument();
  });
  it("shows pending next turn instead of stale active state", () => {
    show({ speed: "standard", speedObservation: { requested: "fast", state: "fast" } });
    expect(screen.getByText("Applies next turn")).toBeInTheDocument();
    expect(screen.queryByText("Fast active")).toBeNull();
  });
  it("makes cooldown and provider reason inspectable", () => {
    show({ speedObservation: { requested: "fast", state: "cooldown", reason: "account cooling down" } });
    expect(screen.getByText("Fast cooldown")).toHaveAttribute("title", expect.stringContaining("account cooling down"));
  });
});

it("configuration invalidation shows next-turn pending while retaining historical detail", () => {
  show({ speedPending: true, speedLastObservation: { requested: "fast", state: "fast", reason: "last turn only" } });
  expect(screen.getByText("Applies next turn")).toHaveAttribute("title", expect.stringContaining("last turn only"));
  expect(screen.queryByText("Last reported: Fast")).toBeNull();
});
