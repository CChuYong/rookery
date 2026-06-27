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
