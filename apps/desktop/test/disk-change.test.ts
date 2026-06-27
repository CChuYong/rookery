import { describe, it, expect } from "vitest";
import { decideDiskChange } from "../src/renderer/lib/disk-change.js";

// Pure logic that decides what to do based on disk content, what we just wrote, the buffer, and the baseline when the fs watcher fires fs:changed.
describe("decideDiskChange", () => {
  it("ignores our own save echo (disk equals what we just wrote)", () => {
    // Watcher echo right after Cmd+S: disk = what we just wrote. Ignore even if the baseline (saved) hasn't been updated yet.
    expect(decideDiskChange({ disk: "v2", lastWritten: "v2", buffer: "v2", saved: "v1" })).toBe("ignore");
  });

  it("ignores our own save echo even if the user kept typing after saving", () => {
    expect(decideDiskChange({ disk: "v2", lastWritten: "v2", buffer: "v3", saved: "v1" })).toBe("ignore");
  });

  it("ignores a spurious event where disk still equals our baseline", () => {
    expect(decideDiskChange({ disk: "v1", lastWritten: null, buffer: "v1", saved: "v1" })).toBe("ignore");
  });

  it("adopts an external change silently when the buffer is clean", () => {
    expect(decideDiskChange({ disk: "ext", lastWritten: null, buffer: "v1", saved: "v1" })).toBe("adopt");
  });

  it("shows a banner when the buffer is dirty and the disk genuinely changed externally", () => {
    expect(decideDiskChange({ disk: "ext", lastWritten: "v2", buffer: "myedits", saved: "v1" })).toBe("banner");
  });

  it("treats never-saved (lastWritten null) external changes normally", () => {
    expect(decideDiskChange({ disk: "ext", lastWritten: null, buffer: "dirty", saved: "v1" })).toBe("banner");
  });
});
