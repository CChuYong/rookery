import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readSelectedAttachment } from "../src/main/selected-attachment.js";
it("bounds selected-image reads, refuses symlinks and preserves nonimage paths", async () => {
  const home = await mkdtemp(join(tmpdir(), "rookery-selected-"));
  try {
    const image = join(home, "selected.png");
    await writeFile(image, Buffer.from("synthetic"));
    expect(await readSelectedAttachment(image)).toMatchObject({
      name: "selected.png",
      mediaType: "image/png",
      base64: Buffer.from("synthetic").toString("base64"),
    });
    const large = join(home, "large.png");
    await writeFile(large, Buffer.alloc(3 * 1024 * 1024 + 1));
    await expect(readSelectedAttachment(large)).rejects.toThrow("size");
    const link = join(home, "link.png");
    await symlink(image, link);
    await expect(readSelectedAttachment(link)).rejects.toThrow();
    await expect(readSelectedAttachment(join(home, "bad.svg"))).rejects.toThrow(
      "Unsupported",
    );
    expect(await readSelectedAttachment(join(home, "notes.md"))).toEqual({
      path: join(home, "notes.md"),
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
