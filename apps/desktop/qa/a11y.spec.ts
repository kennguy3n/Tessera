import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { SURFACES, THEME_VARIANTS, gotoSurface } from "./surfaces";

/**
 * Browser-side accessibility audit: the half of the a11y pass that jsdom
 * cannot decide because it has no layout/painting — chiefly
 * `color-contrast` in BOTH themes, plus a full WCAG 2.1 A/AA structural
 * sweep in a real browser. (The jsdom Vitest suite covers structure on
 * every page/surface; this re-checks structure in-browser and adds the
 * contrast rules.)
 *
 * Runs against the deterministic showcase QA bundle. Fix violations at
 * the source — do not narrow the ruleset to make it pass.
 */
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

test.describe("a11y (browser / contrast)", () => {
  for (const surface of SURFACES) {
    for (const variant of THEME_VARIANTS) {
      test(`${surface.id} — ${variant.id}`, async ({ page }, testInfo) => {
        await gotoSurface(page, surface, variant);

        const results = await new AxeBuilder({ page })
          .withTags(WCAG_TAGS)
          .analyze();

        if (results.violations.length > 0) {
          // Attach a readable report so failures are actionable without
          // re-running with a debugger.
          const report = results.violations
            .map((v) => {
              const nodes = v.nodes
                .map((n) => `      - ${n.target.join(" ")}\n        ${n.failureSummary?.replace(/\n/g, "\n        ")}`)
                .join("\n");
              return `  [${v.impact}] ${v.id}: ${v.help}\n    ${v.helpUrl}\n${nodes}`;
            })
            .join("\n\n");
          await testInfo.attach(`axe-${surface.id}-${variant.id}.txt`, {
            body: report,
            contentType: "text/plain",
          });
        }

        expect(
          results.violations,
          `axe found ${results.violations.length} violation(s) on "${surface.title}" (${variant.id})`,
        ).toEqual([]);
      });
    }
  }
});
