import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { realClaudeWorkflowFiles } from "../../src/daemon/claude-workflow-files.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))));

describe("realClaudeWorkflowFiles", () => {
  it("reads exact byte ranges and bounded text", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rookery-workflow-files-"));
    dirs.push(dir);
    const file = path.join(dir, "journal.jsonl");
    await fs.writeFile(file, "one\ntwo\n", "utf8");
    expect((await realClaudeWorkflowFiles.read(file, 4, 3)).toString("utf8")).toBe("two");
    expect(await realClaudeWorkflowFiles.readText(file, 4)).toBe("two\n");
    expect(await realClaudeWorkflowFiles.stat(file)).toMatchObject({ size: 8, isFile: true });
    expect(await realClaudeWorkflowFiles.realpath(dir)).toBe(await fs.realpath(dir));
  });

  it("reports a directory change through one disposable watcher", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rookery-workflow-watch-"));
    dirs.push(dir);
    const changed = new Promise<string | null>((resolve) => {
      const watch = realClaudeWorkflowFiles.watchDirectory(dir, (name) => {
        watch.close();
        resolve(name);
      });
    });
    await fs.writeFile(path.join(dir, "journal.jsonl"), "{}\n", "utf8");
    const filename = await changed;
    // fs.watch deliberately does not guarantee a filename. macOS may report
    // the watched directory's basename instead of the changed entry.
    expect(filename === null || typeof filename === "string").toBe(true);
  });
});
