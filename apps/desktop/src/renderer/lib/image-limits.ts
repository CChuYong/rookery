import type { ImageRef } from "@daemon/core/image-input.js";

// Renderer copy of the daemon's per-message image bounds and ref validator (src/core/image-input.ts).
// The renderer must not runtime-import daemon code (apps/desktop/AGENTS.md: `@daemon/*` is type-only), so this is an
// intentional cross-build duplicate — test/image-limits-parity.test.ts pins it to the daemon values. The daemon
// re-validates every ref on send; this copy only gives the composer an early, local rejection.
export const IMAGE_LIMITS = Object.freeze({
  count: 4,
  fileBytes: 3 * 1024 * 1024,
  messageBytes: 8 * 1024 * 1024,
  dimension: 8000,
  pixels: 20_000_000,
});

const MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const IMAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateImageRefs(refs: readonly ImageRef[]): ImageRef[] {
  if (refs.length > IMAGE_LIMITS.count) throw new Error("At most 4 images per message");
  let total = 0;
  for (const ref of refs) {
    if (!IMAGE_ID.test(ref.id)) throw new Error("Invalid image id; retry with an uploaded image");
    if (!MEDIA_TYPES.includes(ref.mediaType)) throw new Error("Unsupported image type");
    if (!Number.isSafeInteger(ref.byteLength) || ref.byteLength <= 0 || ref.byteLength > IMAGE_LIMITS.fileBytes)
      throw new Error("Image exceeds 3 MiB limit");
    if (
      ![ref.width, ref.height].every((n) => Number.isSafeInteger(n) && n > 0 && n <= IMAGE_LIMITS.dimension) ||
      ref.width * ref.height > IMAGE_LIMITS.pixels
    )
      throw new Error("Image dimensions exceed limits");
    total += ref.byteLength;
  }
  if (total > IMAGE_LIMITS.messageBytes) throw new Error("Images exceed 8 MiB message limit");
  return refs.map((ref) => ({ ...ref }));
}
