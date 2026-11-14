import { useEffect, useRef, useState } from "react";
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
export async function loadImage(ref: ImageRef): Promise<string> {
  const hit = cache.get(ref.id);
  if (hit) {
    cache.delete(ref.id);
    cache.set(ref.id, hit);
    return hit;
  }
  const pending = inFlight.get(ref.id);
  if (pending) return pending;
  const task = getImageClient()
    .request({ type: "image.get", id: ref.id })
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
    </div>
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
