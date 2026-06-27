import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
export default defineConfig({
  test: { include: ["test/**/*.test.{ts,tsx}"], environment: "jsdom", globals: true, setupFiles: ["./test/setup.ts"] },
  resolve: { alias: { "@daemon": resolve(__dirname, "../../src") } },
});
