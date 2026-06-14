import { defineConfig } from "@playwright/test";

/**
 * Playwright config for Tessera's browser-driven quality gates:
 *
 *   - `visual`  — deterministic screenshot snapshots of the key
 *                 surfaces in light + dark (visual-regression).
 *   - `a11y`    — axe-core color-contrast + structural audit of the
 *                 same surfaces in both themes (the browser half of the
 *                 a11y pass that jsdom can't decide).
 *
 * Both run against the showcase-enabled production bundle
 * (`npm run build:qa` → `renderer-dist-qa/`) served by `preview:qa`.
 * The bundle is seeded with deterministic persona data and reads
 * `?theme=`/`?accent=` so captures are reproducible. `npm run build:qa`
 * must have run first; the `webServer` below only serves it.
 *
 * Determinism levers:
 *   - fixed 1440×900 viewport, deviceScaleFactor 1.
 *   - `reducedMotion: "reduce"` so `prefers-reduced-motion` gates every
 *     animation/transition off (the design system honours it).
 *   - `--force-color-profile=srgb` + `--font-render-hinting=none` to pin
 *     colour management and glyph hinting across machines.
 *   - screenshots assert with a small pixel tolerance to absorb
 *     residual sub-pixel AA without hiding real diffs.
 */
const PORT = Number(process.env.TESSERA_QA_PORT || 5180);
// 127.0.0.1, not "localhost": `vite preview` binds IPv4 by default, but in
// some environments (notably the CI Playwright container) "localhost"
// resolves to IPv6 (::1) first, so a "localhost" health-check would hang on a
// refused IPv6 connection until the webServer timeout even though the server
// is up on IPv4. The `webServer.command` below pins vite to the same IPv4 host
// so the probe and the bind agree. This mirrors scripts/perfBudgets.mjs.
const HOST = "127.0.0.1";
const BASE_URL = `http://${HOST}:${PORT}`;

export default defineConfig({
  testDir: ".",
  // CI flake guard: a single retry, no parallel sharding of a shared
  // preview server. Snapshots are deterministic so retries shouldn't be
  // needed, but one absorbs a cold-cache first-paint hiccup.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  timeout: 60_000,
  expect: {
    timeout: 10_000,
    toHaveScreenshot: {
      // Sub-pixel AA differs slightly across GPUs/font stacks; allow a
      // tiny ratio so genuine layout/colour diffs still fail loudly.
      maxDiffPixelRatio: 0.02,
      animations: "disabled",
      caret: "hide",
      scale: "css",
    },
  },
  use: {
    baseURL: BASE_URL,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    // `reducedMotion` is a browser-context option, not a top-level test
    // option, so it must be nested under `contextOptions` to actually be
    // applied (and to type-check). This makes `prefers-reduced-motion:
    // reduce` true for every page, which the design system honours to
    // gate transitions/animations off.
    contextOptions: { reducedMotion: "reduce" },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "visual",
      testMatch: /visual\.spec\.ts$/,
      // Default (bundled) Chromium, NOT channel:"chrome": the browser
      // version is then pinned by the @playwright/test version, so
      // baselines stay reproducible across machines. Viewport/dSF come
      // from the top-level `use` (1440×900) — no device preset, which
      // would silently override them.
      use: {
        launchOptions: {
          args: [
            "--force-color-profile=srgb",
            "--font-render-hinting=none",
            "--disable-lcd-text",
          ],
        },
      },
    },
    {
      name: "a11y",
      testMatch: /a11y\.spec\.ts$/,
    },
  ],
  webServer: {
    // `-- --host 127.0.0.1`: pin vite preview to the same IPv4 address the
    // health-check (`url` below) probes, so the bind and the probe agree even
    // where "localhost" would resolve to IPv6 first. preview:qa already pins
    // the port and passes --strictPort.
    command: `npm run preview:qa -- --host ${HOST}`,
    cwd: "..",
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
