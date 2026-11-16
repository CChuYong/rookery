import { describe, it, expect } from "vitest";
import { changedSettingKeys, dirtyTabs, msParts } from "../src/renderer/lib/settings-draft.js";
import type { SettingsValues } from "@daemon/core/settings.js";

const base = { masterName: "rookery", masterModel: "m", slackLocale: "ko", codexBin: "codex" } as unknown as SettingsValues;

describe("changedSettingKeys", () => {
  it("is empty for an untouched draft", () => {
    expect(changedSettingKeys({ ...base }, base)).toEqual([]);
  });

  it("lists every key whose value differs", () => {
    expect(changedSettingKeys({ ...base, masterName: "x", codexBin: "/bin/codex" }, base)).toEqual(["masterName", "codexBin"]);
  });

  it("treats a missing key and an empty string as the same value (typing then clearing is not a change)", () => {
    expect(changedSettingKeys({ ...base, defaultSessionCwd: "" } as SettingsValues, base)).toEqual([]);
  });

  it("counts a key that only exists in the draft", () => {
    expect(changedSettingKeys({ ...base, masterSpeed: "fast" } as SettingsValues, base)).toEqual(["masterSpeed"]);
  });
});

describe("dirtyTabs", () => {
  it("maps changed keys to the settings category that owns them", () => {
    expect(dirtyTabs(["masterName", "slackLocale", "masterModel", "codexBin"])).toEqual(new Set(["general", "slack", "models"]));
  });

  it("ignores keys that no category edits", () => {
    expect(dirtyTabs(["hasAcceptedDataNotice"])).toEqual(new Set());
  });
});

describe("msParts", () => {
  it("reads whole minutes", () => {
    expect(msParts("120000")).toEqual({ unit: "m", value: 2 });
  });
  it("reads seconds below a minute or when not a whole minute", () => {
    expect(msParts("30000")).toEqual({ unit: "s", value: 30 });
    expect(msParts("90000")).toEqual({ unit: "s", value: 90 });
  });
  it("reads whole hours", () => {
    expect(msParts("7200000")).toEqual({ unit: "h", value: 2 });
  });
  it("keeps sub-second values in ms", () => {
    expect(msParts("1500")).toEqual({ unit: "ms", value: 1500 });
  });
  it("returns off for 0 and nothing for blank or invalid input", () => {
    expect(msParts("0")).toEqual({ unit: "off" });
    expect(msParts("")).toBeNull();
    expect(msParts("abc")).toBeNull();
    expect(msParts("-5")).toBeNull();
  });
});
