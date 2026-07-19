import { describe, it, expect } from "vitest";
import { notifyFor } from "../src/renderer/lib/notify.js";
import { catalogs } from "../src/renderer/i18n/catalog.js";
import { translate } from "../src/renderer/i18n/core.js";

const ko = (k: string): string => translate(catalogs.ko, k);
const en = (k: string): string => translate(catalogs.en, k);

describe("notifyFor", () => {
  it("notifies on entering idle/done/failed, with status-specific text + label (ko)", () => {
    expect(notifyFor("running", "idle", "app", ko)?.title).toContain("app");
    expect(notifyFor("running", "idle", "app", ko)?.body).toMatch(/대기|입력/);
    expect(notifyFor("running", "done", "app", ko)?.body).toMatch(/완료/);
    expect(notifyFor("running", "failed", "app", ko)?.body).toMatch(/실패|에러/);
  });

  it("uses the provided translator (en)", () => {
    expect(notifyFor("running", "done", "app", en)?.body).toBe("Task complete");
  });

  it("does NOT notify on unchanged status or non-notable targets", () => {
    expect(notifyFor("idle", "idle", "x", ko)).toBeNull(); // same status re-emitted
    expect(notifyFor(undefined, "running", "x", ko)).toBeNull(); // entering running does not notify
    expect(notifyFor("running", "running", "x", ko)).toBeNull();
  });
});

// Coverage across the worker state graph: `error` (written by Worker.transition) is the live sibling of
// `failed` (written by FleetOrchestrator.setStatus) and was silently unnotified.
describe("notifyFor across the worker state graph", () => {
  it("notifies on error, the live sibling of failed", () => {
    expect(notifyFor("running", "error", "app", ko)?.body).toMatch(/실패|에러/);
    expect(notifyFor("running", "error", "app", en)?.body).toBe("Failed — an error occurred");
  });

  it("does NOT notify on entering background — the worker is still working", () => {
    expect(notifyFor("running", "background", "app", ko)).toBeNull();
  });

  it("notifies on stopped, the live replacement for the retired done state", () => {
    expect(notifyFor("background", "stopped", "app", ko)?.body).toMatch(/중지/);
  });
});
