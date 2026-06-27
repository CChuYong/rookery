// Extensions eligible for image preview (kept in sync with WorkspaceManager.readImage's IMAGE_MIME).
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "avif"]);

export function isImagePath(path: string): boolean {
  return IMAGE_EXT.has(path.split(".").pop()?.toLowerCase() ?? "");
}
