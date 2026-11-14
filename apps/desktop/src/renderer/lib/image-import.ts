import { IMAGE_LIMITS, validateImageRefs } from "@daemon/core/image-input.js";
import type { ImageRef, ImageMediaType } from "@daemon/core/image-input.js";
import type { WsClient } from "../ws/client.js";
export type SelectedAttachment =
  | { path: string }
  | { name: string; mediaType: string; byteLength: number; base64: string };
export class ImageImportError extends Error {
  constructor(
    public readonly reason:
      | "type"
      | "size"
      | "count"
      | "total"
      | "dimensions"
      | "quota"
      | "failed",
  ) {
    super(reason);
  }
}
const TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
export function isImageFile(file: Pick<File, "name" | "type">): boolean {
  return (
    file.type.startsWith("image/") ||
    /\.(png|jpe?g|webp|gif|svg|avif|heic|bmp|tiff?)$/i.test(file.name)
  );
}
export function checkImage(
  name: string,
  type: string,
  size: number,
): ImageMediaType {
  const mime =
    type ||
    (
      {
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        webp: "image/webp",
        gif: "image/gif",
      } as Record<string, string>
    )[name.split(".").pop()?.toLowerCase() ?? ""];
  if (!TYPES.includes(mime)) throw new ImageImportError("type");
  if (!Number.isSafeInteger(size) || size <= 0 || size > IMAGE_LIMITS.fileBytes)
    throw new ImageImportError("size");
  return mime as ImageMediaType;
}
export function checkImageBatch(
  existing: readonly ImageRef[],
  sizes: number[],
): void {
  if (existing.length + sizes.length > IMAGE_LIMITS.count)
    throw new ImageImportError("count");
  if (
    existing.reduce((n, i) => n + i.byteLength, 0) +
      sizes.reduce((n, s) => n + s, 0) >
    IMAGE_LIMITS.messageBytes
  )
    throw new ImageImportError("total");
}
function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]!);
    reader.onerror = () => reject(new ImageImportError("failed"));
    reader.readAsDataURL(file);
  });
}
export async function importImage(
  file: File | Exclude<SelectedAttachment, { path: string }>,
  client: Pick<WsClient, "request">,
): Promise<ImageRef> {
  const size = "size" in file ? file.size : file.byteLength;
  const mediaType = checkImage(
    file.name,
    "type" in file ? file.type : file.mediaType,
    size,
  );
  // No browser image decode occurs before authoritative header/dimension validation.
  const base64 = "base64" in file ? file.base64 : await readBase64(file);
  const result = await client
    .request({
      type: "image.upload",
      name: file.name,
      mediaType,
      base64,
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "";
      if (/dimension|pixel/i.test(message))
        throw new ImageImportError("dimensions");
      if (/quota/i.test(message)) throw new ImageImportError("quota");
      throw new ImageImportError("failed");
    });
  return validateImageRefs([result.image])[0]!;
}
