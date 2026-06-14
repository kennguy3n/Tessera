import { test, expect } from "@playwright/test";
import { SURFACES, THEME_VARIANTS, gotoSurface } from "./surfaces";

/**
 * Visual-regression snapshots for every key surface in light + dark
 * (plus one accent), against the deterministic showcase QA bundle.
 *
 * Update baselines (the documented one-command flow):
 *   npm run qa:visual:update   (in apps/desktop; rebuilds the QA bundle first)
 *
 * Determinism is enforced by the config (fixed viewport, reduced motion,
 * srgb colour profile, disabled animations) and the seeded showcase data.
 */
test.describe("visual regression", () => {
  for (const surface of SURFACES) {
    for (const variant of THEME_VARIANTS) {
      test(`${surface.id} — ${variant.id}`, async ({ page }) => {
        await gotoSurface(page, surface, variant);
        await expect(page).toHaveScreenshot(`${surface.id}-${variant.id}.png`, {
          fullPage: surface.kind !== "overlay",
        });
      });
    }
  }
});
