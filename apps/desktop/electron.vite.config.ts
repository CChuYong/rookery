import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  // externalizeDepsPlugin: leave package.json deps as runtime require()s instead of bundling them.
  // Native modules like node-pty must be external so they can dynamically load their own prebuild (.node)
  // (if bundled, they die at runtime with "Could not dynamically require ./prebuilds/.../pty.node").
  main: { plugins: [externalizeDepsPlugin()], build: { rollupOptions: { input: resolve(__dirname, "src/main/index.ts") } } },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/preload/index.ts"),
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    build: { rollupOptions: { input: resolve(__dirname, "src/renderer/index.html") } },
    plugins: [react(), tailwindcss()],
    resolve: { alias: { "@daemon": resolve(__dirname, "../../src") } },
    // monaco-editor registers language grammars (syntax coloring) via lazy import(). Vite dev's esbuild optimizeDeps
    // breaks this internal dynamic import, so coloring is missing in dev only (the prod bundle is fine). Excluded from pre-bundling so it's served as-is ESM.
    optimizeDeps: { exclude: ["monaco-editor"] },
  },
});
