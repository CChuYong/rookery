import { describe, it, expect } from "vitest";
import { useStore } from "../src/renderer/store/store.js";

describe("store codexModels", () => {
  it("initial state is null", () => {
    // Reset explicitly since the store is a singleton shared across test files.
    useStore.setState({ codexModels: null });
    expect(useStore.getState().codexModels).toBeNull();
  });

  it("setCodexModels stores the list as-is (no static-fallback coercion, unlike setModels)", () => {
    const list = [{ id: "gpt-5.5", displayName: "GPT-5.5", defaultEffort: "xhigh", supportedEfforts: ["low", "medium", "high", "xhigh"], isDefault: true }];
    useStore.getState().setCodexModels(list);
    expect(useStore.getState().codexModels).toBe(list);
  });

  it("setCodexModels(null) resets to null (couldn't fetch → free-text fallback surfaces)", () => {
    useStore.getState().setCodexModels([{ id: "gpt-5.5", displayName: "GPT-5.5", defaultEffort: "xhigh", supportedEfforts: ["low"], isDefault: true }]);
    useStore.getState().setCodexModels(null);
    expect(useStore.getState().codexModels).toBeNull();
  });
});
