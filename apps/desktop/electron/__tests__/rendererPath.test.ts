import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = path.resolve(HERE, "..", "..");
const REPO_ROOT = path.resolve(DESKTOP_ROOT, "..", "..");

/**
 * Regression test: the four moving parts that determine where the packaged
 * Electron app loads its renderer from MUST agree on a single canonical
 * directory name. The failure mode this guards against was a blank
 * window in production builds because:
 *
 *   - `vite.config.ts` emitted the renderer to `apps/desktop/renderer-dist/`
 *   - `electron/main.ts` loaded `apps/desktop/dist/index.html`
 *
 * Those names disagreed silently because nothing was type-checking the
 * cross-config relationship. This test pins them together so any future
 * rename has to touch every site at once.
 *
 * The companion regression is that Vite's default `base: "/"` makes
 * the built `index.html` reference assets via absolute URLs which
 * never resolve under `file://` — captured here too.
 */
describe("packaged Electron renderer wiring", () => {
  it("vite.config.ts builds the renderer into renderer-dist/", () => {
    const viteConfig = readFileSync(
      path.join(DESKTOP_ROOT, "vite.config.ts"),
      "utf-8",
    );
    expect(viteConfig).toMatch(
      /outDir:\s*path\.resolve\(__dirname,\s*"renderer-dist"\)/,
    );
  });

  it("vite.config.ts sets base to './' so assets resolve under file://", () => {
    const viteConfig = readFileSync(
      path.join(DESKTOP_ROOT, "vite.config.ts"),
      "utf-8",
    );
    expect(viteConfig).toMatch(/base:\s*"\.\/"/);
  });

  it("electron/main.ts production branch loads ../../renderer-dist/index.html", () => {
    const mainTs = readFileSync(
      path.join(DESKTOP_ROOT, "electron", "main.ts"),
      "utf-8",
    );
    // The Electron main bundle is emitted to
    // `dist-electron/electron/main.js` (Workstream 1 sibling-rooted
    // layout — see `tsconfig.electron.json`), so the renderer
    // entrypoint lives two levels up from `__dirname` instead of one.
    // Tolerate prettier wrapping the call across multiple lines (and a
    // trailing comma on the inner argument).
    expect(mainTs).toMatch(
      /loadFile\(\s*path\.join\(\s*__dirname,\s*"\.\.\/\.\.\/renderer-dist\/index\.html"\s*,?\s*\)\s*,?\s*\)/,
    );
    expect(mainTs).not.toMatch(/"\.\.\/dist\/index\.html"/);
  });

  it("all electron-builder configs ship renderer-dist + dist-electron and exclude apps/desktop/dist", () => {
    const configs = [
      "packaging/electron-builder.yml",
      "packaging/linux/electron-builder-linux.yml",
      "packaging/macos/electron-builder-mac.yml",
      "packaging/windows/electron-builder-win.yml",
    ];
    for (const rel of configs) {
      const body = readFileSync(path.join(REPO_ROOT, rel), "utf-8");
      expect(body, `${rel} missing renderer-dist glob`).toContain(
        "apps/desktop/renderer-dist/**/*",
      );
      expect(body, `${rel} missing dist-electron glob`).toContain(
        "apps/desktop/dist-electron/**/*",
      );
      expect(
        body,
        `${rel} still references stale apps/desktop/dist glob`,
      ).not.toMatch(/apps\/desktop\/dist\/\*/);
    }
  });
});
