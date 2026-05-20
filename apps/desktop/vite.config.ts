/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  root: path.resolve(__dirname, "renderer"),
  // Vite defaults `base` to `/`, which makes the built `index.html` reference
  // assets as absolute URLs like `<script src="/assets/main-abc.js">`. In the
  // packaged Electron app the renderer is loaded via `file://`, so an
  // absolute URL resolves to the filesystem root and every asset 404s,
  // leaving the user with a blank window. `base: "./"` makes Vite emit
  // relative URLs (`./assets/main-abc.js`) which resolve correctly under
  // `file://`. The dev server runs from `http://localhost:5173/` so relative
  // and absolute base both work in dev.
  base: "./",
  build: {
    outDir: path.resolve(__dirname, "renderer-dist"),
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "renderer/src"),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/__tests__/setup.ts"],
    include: [
      "src/**/*.{test,spec}.{ts,tsx}",
      "../electron/**/*.{test,spec}.ts",
    ],
  },
});
