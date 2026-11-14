import { open } from "node:fs/promises";
import { basename, extname } from "node:path";
import { constants } from "node:fs";
// Called only with a path returned by the native dialog in this process. No path is accepted over IPC.
export async function readSelectedAttachment(
  path: string,
): Promise<
  | { path: string }
  | { name: string; mediaType: string; byteLength: number; base64: string }
> {
  const extension = extname(path).toLowerCase();
  const mediaType = (
    {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".gif": "image/gif",
    } as Record<string, string>
  )[extension];
  if (!mediaType) {
    if (/\.(svg|avif|heic|bmp|tiff?)$/i.test(path))
      throw new Error("Unsupported image type");
    return { path };
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    const limit = 3 * 1024 * 1024;
    if (!info.isFile() || info.size <= 0 || info.size > limit)
      throw new Error("Image exceeds size limit");
    // Bounded read even if another process grows the selected file after stat.
    const bytes = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(
        bytes,
        offset,
        bytes.length - offset,
        null,
      );
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    if (offset !== info.size) throw new Error("Image changed while reading");
    return {
      name: basename(path),
      mediaType,
      byteLength: offset,
      base64: bytes.subarray(0, offset).toString("base64"),
    };
  } finally {
    await file.close();
  }
}
