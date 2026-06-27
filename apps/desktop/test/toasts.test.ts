import { describe, it, expect, beforeEach } from "vitest";
import { useToastStore, toast } from "../src/renderer/store/toasts.js";

beforeEach(() => useToastStore.setState({ toasts: [] }));

describe("toast store", () => {
  it("push appends a toast and returns an id", () => {
    const id = useToastStore.getState().push({ kind: "error", text: "boom" });
    const ts = useToastStore.getState().toasts;
    expect(ts).toHaveLength(1);
    expect(ts[0]).toMatchObject({ id, kind: "error", text: "boom" });
  });

  it("coalesces an identical kind+text (no duplicate stacking)", () => {
    useToastStore.getState().push({ kind: "error", text: "same" });
    useToastStore.getState().push({ kind: "error", text: "same" });
    const ts = useToastStore.getState().toasts;
    expect(ts).toHaveLength(1);
    expect(ts[0].text).toBe("same");
  });

  it("does NOT coalesce a different kind or text", () => {
    useToastStore.getState().push({ kind: "error", text: "a" });
    useToastStore.getState().push({ kind: "success", text: "a" });
    useToastStore.getState().push({ kind: "error", text: "b" });
    expect(useToastStore.getState().toasts).toHaveLength(3);
  });

  it("caps visible toasts to the most recent 4", () => {
    for (let i = 0; i < 7; i++) useToastStore.getState().push({ kind: "info", text: `t${i}` });
    const ts = useToastStore.getState().toasts;
    expect(ts).toHaveLength(4);
    expect(ts.map((x) => x.text)).toEqual(["t3", "t4", "t5", "t6"]);
  });

  it("dismiss removes by id", () => {
    const id1 = useToastStore.getState().push({ kind: "info", text: "x" });
    const id2 = useToastStore.getState().push({ kind: "info", text: "y" });
    useToastStore.getState().dismiss(id1);
    const ts = useToastStore.getState().toasts;
    expect(ts).toHaveLength(1);
    expect(ts[0].id).toBe(id2);
  });

  it("toast.error facade pushes an error toast with detail", () => {
    toast.error("oops", "detail");
    expect(useToastStore.getState().toasts[0]).toMatchObject({ kind: "error", text: "oops", detail: "detail" });
  });
});
