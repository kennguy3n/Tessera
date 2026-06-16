import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { financeDataset } from "../generated/finance";
import { retailDataset } from "../generated/retail";
import { financeKnowledge } from "../generated/finance.knowledge";
import { retailKnowledge } from "../generated/retail.knowledge";

/**
 * Drift guard for the QA visual-regression + a11y baselines.
 *
 * The committed snapshots in apps/desktop/qa/visual.spec.ts-snapshots/ are
 * rendered from the showcase mock bridge, which serves the auto-generated
 * persona datasets in src/showcase/generated/. The browser QA gates exercise
 * exactly two personas (see apps/desktop/qa/surfaces.ts): `finance` backs the
 * document / sheet / route / overlay surfaces, and `retail` backs the slide /
 * base surfaces. Their knowledge planes also feed the Memory (concept graph)
 * surface, so both the datasets and the planes contribute to baselines.
 *
 * Those fixtures are regenerated out-of-band by scripts/showcase/generate.py.
 * When that happens the rendered surfaces change but the committed baselines
 * are NOT refreshed, so the visual gate drifts silently: a small content edit
 * can slip under Playwright's `maxDiffPixelRatio` (2%) tolerance and quietly
 * invalidate the baselines, until an unrelated layout change tips the
 * accumulated diff over the threshold and fails a PR that never touched the
 * showcase. (That is exactly what happened to the slide-editor baselines,
 * captured against an older `retail.ts` and never refreshed when the fixture
 * changed `type: "text"` dashed bullets into `type: "bullets"`.)
 *
 * This test pins a hash of exactly the data the QA surfaces render. If the
 * finance/retail fixtures change it fails fast in the regular unit suite — on
 * every platform, with no Playwright container — with an actionable message,
 * so the baselines are regenerated in the same change set instead of rotting.
 */

/**
 * Key-sorted serialization so the hash depends only on the values, never on
 * object key insertion order.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return Object.keys(obj)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = canonicalize(obj[key]);
        return acc;
      }, {});
  }
  return value;
}

function qaFixtureHash(): string {
  const payload = canonicalize({
    finance: { dataset: financeDataset, knowledge: financeKnowledge },
    retail: { dataset: retailDataset, knowledge: retailKnowledge },
  });
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/**
 * Hash of the finance + retail showcase fixtures the committed QA baselines
 * were last verified against.
 *
 * When this test fails because the fixtures changed, regenerate the affected
 * baselines:
 *
 *   npm run build:qa --workspace=apps/desktop
 *   npx playwright test --config qa/playwright.config.ts --project=visual \
 *     --update-snapshots
 *
 * (run inside the pinned `mcr.microsoft.com/playwright:v1.60.0-jammy`
 * container on Node 20 for byte-identical fonts — see .github/workflows/ci.yml),
 * then paste the new hash printed in the failure message below.
 */
const EXPECTED_QA_FIXTURE_HASH =
  "0943b9a3c9ab168b4e0cf7f1765a68f454e4d99cecbf51d0243e77b59ca8801e";

describe("QA showcase fixture baseline-drift guard", () => {
  it("keeps the finance + retail fixtures in sync with the committed visual baselines", () => {
    const actual = qaFixtureHash();
    expect(
      actual,
      "The finance/retail showcase fixtures that back the QA visual + a11y " +
        "baselines changed. Regenerate the snapshots in " +
        "apps/desktop/qa/visual.spec.ts-snapshots/ and set " +
        `EXPECTED_QA_FIXTURE_HASH to "${actual}".`,
    ).toBe(EXPECTED_QA_FIXTURE_HASH);
  });
});
