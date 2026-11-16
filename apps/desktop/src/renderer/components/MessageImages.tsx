import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useModalKeys } from "../lib/useModalKeys.js";
import { useFocusTrap } from "../lib/useFocusTrap.js";
import type { ImageRef } from "@daemon/core/image-input.js";
import { getImageClient } from "../lib/image-client.js";
import { useT } from "../i18n/provider.js";
// A bounded LRU of validated daemon data. No arbitrary URLs and no transcript-wide eager fetch.
const MAX_CACHE_BYTES = 24 * 1024 * 1024;
const cache = new Map<string, string>();
const inFlight = new Map<string, Promise<string>>();
let cacheBytes = 0;
export function clearImageCache(): void {
  cache.clear();
  cacheBytes = 0;
}
// One image.get on the wire at a time. Each reply can be ~4 MiB of base64, and the daemon cuts a socket whose send
// buffer passes 8 MiB (server.ts backpressure guard) — requesting every visible image at once made a message with
// 3–4 large images disconnect the desktop, and the reconnect re-requested them in a loop. Waiting for each reply
// before asking for the next keeps the daemon's buffer near one image.
type ImageReply = { image: ImageRef; base64: string };
let wire: Promise<unknown> = Promise.resolve();
function fetchSerially(id: string): Promise<ImageReply> {
  const next = wire.then(() => getImageClient().request({ type: "image.get", id }) as Promise<ImageReply>);
  wire = next.catch(() => undefined);
  return next;
}

export async function loadImage(ref: ImageRef): Promise<string> {
  const hit = cache.get(ref.id);
  if (hit) {
    cache.delete(ref.id);
    cache.set(ref.id, hit);
    return hit;
  }
  const pending = inFlight.get(ref.id);
  if (pending) return pending;
  const task = fetchSerially(ref.id)
    .then(({ image, base64 }) => {
      if (
        image.id !== ref.id ||
        !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
          image.mediaType,
        )
      )
        throw new Error("invalid image");
      const url = `data:${image.mediaType};base64,${base64}`;
      while (cacheBytes + url.length > MAX_CACHE_BYTES && cache.size) {
        const [id, value] = cache.entries().next().value!;
        cache.delete(id);
        cacheBytes -= value.length;
      }
      if (url.length <= MAX_CACHE_BYTES) {
        cache.set(ref.id, url);
        cacheBytes += url.length;
      }
      return url;
    })
    .finally(() => inFlight.delete(ref.id));
  inFlight.set(ref.id, task);
  return task;
}
export function MessageImage({
  image,
  eager = false,
}: {
  image: ImageRef;
  eager?: boolean;
}): JSX.Element {
  const t = useT();
  const element = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(eager);
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [zoomed, setZoomed] = useState(false);
  useEffect(() => {
    if (eager || !element.current) return;
    if (typeof IntersectionObserver === "undefined") return; // explicit load remains available on older clients
    const observer = new IntersectionObserver(
      (entries) => {
        setVisible(entries.some((e) => e.isIntersecting));
      },
      { rootMargin: "160px" },
    );
    observer.observe(element.current);
    return () => observer.disconnect();
  }, [eager]);
  useEffect(() => {
    if (!visible) {
      setUrl(undefined);
      return;
    }
    let alive = true;
    setFailed(false);
    void loadImage(image)
      .then((data) => {
        if (alive) setUrl(data);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [image.id, visible, attempt]);
  return (
    <div
      ref={element}
      className="flex min-w-0 flex-col gap-1"
      title={`${image.name} · ${image.width} × ${image.height}`}
    >
      {url ? (
        <button
          type="button"
          onClick={() => setZoomed(true)}
          aria-label={t("images.open", { name: image.name })}
          className="cursor-zoom-in rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-hi"
        >
        <img
          src={url}
          alt={image.name}
          onError={() => {
            const value = cache.get(image.id);
            if (value) {
              cache.delete(image.id);
              cacheBytes -= value.length;
            }
            setUrl(undefined);
            setFailed(true);
          }}
          className="h-20 max-w-[180px] rounded object-contain bg-ink"
        />
        </button>
      ) : (
        <button
          type="button"
          className="h-20 min-w-24 rounded bg-ink px-2 text-meta text-muted"
          onClick={() => {
            setVisible(true);
            setAttempt((n) => n + 1);
          }}
        >
          {t(failed ? "images.retry" : "images.load")}
        </button>
      )}
      <span className="max-w-[180px] truncate text-meta text-muted">
        {image.name}
      </span>
      {zoomed && url && <ImageLightbox url={url} name={image.name} onClose={() => setZoomed(false)} />}
    </div>
  );
}

// Full-size view of an attached/sent image. Thumbnails are capped at 80px high, which is too small to read a
// screenshot; click opens the image at its natural size (scaled down to fit), Escape, the close button or a click
// anywhere closes. Focus (audit #130): trapped on the close button while open, back on the thumbnail afterwards.
function ImageLightbox({ url, name, onClose }: { url: string; name: string; onClose: () => void }): JSX.Element {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  useModalKeys({ escape: "close", onEscape: onClose });
  useFocusTrap(ref);
  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label={name}
      onClick={onClose}
      className="fixed inset-0 z-[120] flex cursor-zoom-out flex-col items-center justify-center gap-2 bg-scrim p-8 motion-safe:animate-[overlay-in_140ms_ease-out]"
    >
      <button
        type="button"
        onClick={onClose}
        aria-label={t("common.close")}
        title={t("images.closePreview")}
        className="absolute right-3 top-3 flex h-7 w-7 items-center justify-center rounded-md text-fg-dim transition-colors hover:bg-raised hover:text-fg"
      >
        <X size={16} />
      </button>
      <img src={url} alt={name} className="min-h-0 max-w-full flex-1 rounded-md object-contain" />
      <span className="max-w-full truncate text-meta text-fg-dim">{name}</span>
      <span className="sr-only">{t("images.closePreview")}</span>
    </div>,
    document.body,
  );
}
export function MessageImages({
  images,
  eager = false,
}: {
  images?: ImageRef[];
  eager?: boolean;
}): JSX.Element | null {
  return images?.length ? (
    <div className="flex flex-wrap gap-2 py-1">
      {images.map((image, index) => (
        <MessageImage
          key={`${image.id}-${index}`}
          image={image}
          eager={eager}
        />
      ))}
    </div>
  ) : null;
}
