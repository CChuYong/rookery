// Shared product bounds; providers may impose additional limits.
export const IMAGE_LIMITS = Object.freeze({
  count: 4,
  fileBytes: 3 * 1024 * 1024,
  messageBytes: 8 * 1024 * 1024,
  dimension: 8000,
  pixels: 20_000_000,
  wsBytes: 16 * 1024 * 1024,
  quotaBytes: 1024 * 1024 * 1024,
});
export type ImageMediaType =
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "image/gif";
export interface ImageRef {
  id: string;
  name: string;
  mediaType: ImageMediaType;
  byteLength: number;
  width: number;
  height: number;
}
export interface ResolvedImage {
  mediaType: ImageMediaType;
  data: string;
}
// `priority` is a delivery hint for a streaming session (only Claude reads it): a steered follow-up
// rides with it so it joins the running turn instead of starting the next one. `uuid` is the provider
// correlation id the Claude adapter stamps on a steered follow-up, so it can see whether a turn consumed it.
export type AgentInput = string | { text: string; images: ResolvedImage[]; priority?: "now" | "next" | "later"; uuid?: `${string}-${string}-${string}-${string}-${string}` };
// Validation returns fresh authoritative refs, never caller-owned metadata. Resolution occurs only at dispatch.
export interface ImageResolver {
  validate(refs: readonly ImageRef[]): ImageRef[];
  resolve(refs: readonly ImageRef[]): ResolvedImage[];
}
export function assertImageId(id: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      id,
    )
  )
    throw new Error("Invalid image id; retry with an uploaded image");
}
export function validateImageRefs(refs: readonly ImageRef[]): ImageRef[] {
  if (refs.length > IMAGE_LIMITS.count)
    throw new Error("At most 4 images per message");
  let total = 0;
  for (const ref of refs) {
    assertImageId(ref.id);
    if (
      !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
        ref.mediaType,
      )
    )
      throw new Error("Unsupported image type");
    if (
      !Number.isSafeInteger(ref.byteLength) ||
      ref.byteLength <= 0 ||
      ref.byteLength > IMAGE_LIMITS.fileBytes
    )
      throw new Error("Image exceeds 3 MiB limit");
    if (
      ![ref.width, ref.height].every(
        (n) => Number.isSafeInteger(n) && n > 0 && n <= IMAGE_LIMITS.dimension,
      ) ||
      ref.width * ref.height > IMAGE_LIMITS.pixels
    )
      throw new Error("Image dimensions exceed limits");
    total += ref.byteLength;
  }
  if (total > IMAGE_LIMITS.messageBytes)
    throw new Error("Images exceed 8 MiB message limit");
  return refs.map((ref) => ({ ...ref }));
}
export function acceptImages(
  resolver: ImageResolver | undefined,
  refs?: readonly ImageRef[],
): ImageRef[] {
  if (!refs?.length) return [];
  validateImageRefs(refs);
  if (!resolver) throw new Error("Image input unavailable; retry");
  return resolver.validate(refs);
}
export function resolveInput(
  text: string,
  refs: readonly ImageRef[],
  resolver?: ImageResolver,
): AgentInput {
  if (!refs.length) return text;
  if (!resolver) throw new Error("Image input unavailable; retry");
  return { text, images: resolver.resolve(refs) };
}
