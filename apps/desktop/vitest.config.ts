import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
export default defineConfig({
  test: { include: ["test/**/*.test.{ts,tsx}"], environment: "jsdom", globals: true, setupFiles: ["./test/setup.ts"] },
  resolve: {
    alias: {
      "@daemon": resolve(__dirname, "../../src"),
      // monaco-editor has no Node-resolvable entry (browser-only "module" field) and can't run under jsdom anyway —
      // swap in the test fake for every import so MonacoEditor.tsx is testable without a real Monaco instance.
      "monaco-editor": resolve(__dirname, "test/mocks/monaco-editor.ts"),
    },
  },
});
