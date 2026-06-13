/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig(({ mode }) => ({
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
  //
  // The `qa` bundle is the exception: it is served over HTTP at the server
  // root by `preview:qa` and navigated to *deep* SPA routes (e.g.
  // `/artifacts/:id/edit`). Relative asset URLs would resolve against the
  // deep path and 404, leaving a blank page — so QA uses an absolute base.
  base: mode === "qa" ? "/" : "./",
  build: {
    // The `qa` mode (`build:qa`) emits a parallel, showcase-enabled
    // bundle into `renderer-dist-qa/` so it never clobbers the real
    // `renderer-dist/` that the packaged app and the cold-start gate
    // consume. See `renderer/.env.qa` for the `VITE_TESSERA_QA` flag.
    outDir: path.resolve(
      __dirname,
      mode === "qa" ? "renderer-dist-qa" : "renderer-dist",
    ),
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
}));
