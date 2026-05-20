/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  root: path.resolve(__dirname, "renderer"),
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
