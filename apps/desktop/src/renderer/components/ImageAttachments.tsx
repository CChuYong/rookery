import { X } from "lucide-react";
import type { ImageRef } from "@daemon/core/image-input.js";
import { MessageImage } from "./MessageImages.js";
import { useT } from "../i18n/provider.js";
export function ImageAttachments({
  images,
  onRemove,
}: {
  images: ImageRef[];
  onRemove: (index: number) => void;
}): JSX.Element | null {
  const t = useT();
  return images.length ? (
    <div className="flex flex-wrap gap-2">
      {images.map((image, index) => (
        <div
          key={`${image.id}-${index}`}
          className="relative rounded bg-ink p-1.5 pr-6"
        >
          <MessageImage image={image} eager />
          <button
            type="button"
            className="absolute right-0 top-0 p-1 text-muted hover:text-fg"
            aria-label={t("images.remove", { name: image.name })}
            onClick={() => onRemove(index)}
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  ) : null;
}
