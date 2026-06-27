import { describe, it, expect } from "vitest";
import { useStore } from "../src/renderer/store/store.js";

describe("store integrations", () => {
  it("setIntegrations stores status", () => {
    expect(useStore.getState().integrations).toBeNull();
    useStore.getState().setIntegrations({ github: { available: true, user: "octo" }, linear: { configured: true, valid: true, user: "CChuYonng" } });
    expect(useStore.getState().integrations?.github.available).toBe(true);
    expect(useStore.getState().integrations?.linear.user).toBe("CChuYonng");
  });
});
