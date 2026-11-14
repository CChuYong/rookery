import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import {
  MessageImages,
  clearImageCache,
  loadImage,
} from "../src/renderer/components/MessageImages.js";
import { setImageClient } from "../src/renderer/lib/image-client.js";
import type { WsClient } from "../src/renderer/ws/client.js";
const image = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  name: "history.png",
  mediaType: "image/png" as const,
  byteLength: 20,
  width: 1,
  height: 1,
};
let observe: (entries: Array<{ isIntersecting: boolean }>) => void;
let request: ReturnType<typeof vi.fn>;
beforeEach(() => {
  clearImageCache();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: typeof observe) {
        observe = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  request = vi.fn().mockResolvedValue({ image, base64: "eHl6" });
  setImageClient({ request } as unknown as WsClient);
});
it("fetches historical bytes only on viewport entry and releases offscreen data", async () => {
  render(<MessageImages images={[image]} />);
  expect(request).not.toHaveBeenCalled();
  expect(screen.queryByRole("img")).toBeNull();
  await act(async () => observe([{ isIntersecting: true }]));
  expect(request).toHaveBeenCalledWith({ type: "image.get", id: image.id });
  expect(screen.getByRole("img")).toHaveAttribute(
    "src",
    "data:image/png;base64,eHl6",
  );
  await act(async () => observe([{ isIntersecting: false }]));
  expect(screen.queryByRole("img")).toBeNull();
});
it("renders missing history placeholder and retries a failed fetch", async () => {
  request.mockRejectedValueOnce(new Error("missing"));
  render(<MessageImages images={[image]} />);
  await act(async () => observe([{ isIntersecting: true }]));
  fireEvent.click(
    await screen.findByRole("button", {
      name: "이미지를 불러올 수 없습니다. 다시 시도",
    }),
  );
  await waitFor(() => expect(screen.getByRole("img")).toBeInTheDocument());
  expect(request).toHaveBeenCalledTimes(2);
});
it("bounds data cache and refetches an evicted oldest image", async () => {
  const base64 = "A".repeat(4 * 1024 * 1024);
  request.mockImplementation(async ({ id }: { id: string }) => ({
    image: { ...image, id },
    base64,
  }));
  for (let n = 0; n < 7; n++)
    await loadImage({
      ...image,
      id: `550e8400-e29b-41d4-a716-44665544000${n}`,
    });
  const calls = request.mock.calls.length;
  await loadImage(image);
  expect(request).toHaveBeenCalledTimes(calls + 1);
});
