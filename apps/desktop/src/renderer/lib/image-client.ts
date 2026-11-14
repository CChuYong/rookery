import type { WsClient } from "../ws/client.js";
let imageClient: WsClient | null = null;
export function setImageClient(client: WsClient | null): void {
  imageClient = client;
}
export function getImageClient(): WsClient {
  if (!imageClient) throw new Error("not connected");
  return imageClient;
}
