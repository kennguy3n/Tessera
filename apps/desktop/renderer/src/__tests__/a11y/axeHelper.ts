/**
 * Shared axe-core driver for the renderer's automated accessibility
 * suite.
 *
 * The renderer already runs under Vitest + jsdom + Testing-Library
 * (see `vite.config.ts` → `test.environment: "jsdom"`), so we reuse
 * that exact harness rather than standing up a second one: every page
 * and interactive surface is rendered with the real component tree and
 * then audited in-place with axe-core. This keeps the a11y gate fast
 * (no browser boot), deterministic, and co-located with the component
 * tests it complements.
 *
 * jsdom does NOT lay out or paint, so two families of axe rules cannot
 * produce a trustworthy result here and are audited in the browser
 * pass instead (Playwright + @axe-core/playwright, see
 * `qa/a11y.spec.ts`):
 *
 *   - `color-contrast` needs real computed colors + font metrics. In
 *     jsdom every element reports a 0×0 box and the default UA colors,
 *     so the rule can only ever return "incomplete" — never a verdict.
 *   - region/landmark sizing heuristics likewise depend on layout.
 *
 * Everything structural — accessible names/roles, label associations,
 * ARIA validity, focus-order semantics, duplicate ids, list/table
 * semantics, heading structure — is fully decidable in jsdom and is
 * what this driver enforces. The browser pass is additive (contrast in
 * both themes), never a replacement.
 */
import axe, { type AxeResults, type RunOptions, type Result } from "axe-core";

/**
 * WCAG 2.1 Level A + AA is Tessera's conformance target (see
 * `SECURITY.md` / product bar). We additionally opt into axe's
 * `best-practice` pack because it catches real, user-affecting defects
 * the raw WCAG tags miss (e.g. `nested-interactive`, `aria-allowed-attr`
 * on custom widgets, redundant `role`s) and the codebase already meets
 * most of them. The single source of truth for "what tags do we hold
 * the UI to" lives here so every surface is judged identically.
 */
export const A11Y_TAGS: readonly string[] = [
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
  "best-practice",
];

/**
 * Rules that cannot be decided in jsdom (they require layout/paint) and
 * are therefore audited in the browser pass instead. Disabled — not
 * downgraded — so a jsdom run never emits a misleading "incomplete"
 * that a reader might mistake for a pass or a fail.
 */
const JSDOM_UNDECIDABLE_RULES: readonly string[] = [
  // Needs real computed colors + glyph geometry; covered by qa/a11y.spec.ts.
  "color-contrast",
];

export interface RunAxeOptions {
  /**
   * Extra rule ids to disable for a single call, on top of the
   * jsdom-undecidable set. Use ONLY with a justifying comment at the
   * call site (e.g. a documented, targeted false-positive). Never use
   * this to silence a real violation.
   */
  readonly disableRules?: readonly string[];
}

function buildRunOptions(options: RunAxeOptions): RunOptions {
  const disabled = [
    ...JSDOM_UNDECIDABLE_RULES,
    ...(options.disableRules ?? []),
  ];
  return {
    runOnly: { type: "tag", values: [...A11Y_TAGS] },
    rules: Object.fromEntries(disabled.map((id) => [id, { enabled: false }])),
    // We assert only on definitive `violations`; surfacing passes /
    // incomplete in the payload just bloats memory across hundreds of
    // runs.
    resultTypes: ["violations"],
  };
}

/**
 * Run axe against an already-rendered subtree and return the raw
 * results. Callers normally use {@link expectNoA11yViolations}; this is
 * exposed for the rare test that wants to assert on a specific expected
 * (and justified) violation shape.
 */
export async function runAxe(
  container: HTMLElement,
  options: RunAxeOptions = {},
): Promise<AxeResults> {
  return axe.run(container, buildRunOptions(options));
}

/**
 * Format axe violations into a single, copy-pasteable failure message:
 * the rule id, its WCAG impact, the help URL, and every offending node's
 * selector + the exact failure summary axe produced. This is what a
 * maintainer reads when the gate goes red, so it has to be enough to fix
 * the issue without re-running axe by hand.
 */
export function formatViolations(violations: readonly Result[]): string {
  return violations
    .map((v) => {
      const nodes = v.nodes
        .map((n) => {
          const target = n.target.join(" ");
          const summary = (n.failureSummary ?? "").replace(/\n/g, "\n        ");
          return `      • ${target}\n        ${summary}`;
        })
        .join("\n");
      return (
        `  [${v.impact ?? "n/a"}] ${v.id}: ${v.help}\n` +
        `    ${v.helpUrl}\n${nodes}`
      );
    })
    .join("\n\n");
}

/**
 * Assert the rendered subtree has zero axe violations. On failure the
 * thrown message lists every violation with actionable detail (see
 * {@link formatViolations}).
 */
export async function expectNoA11yViolations(
  container: HTMLElement,
  options: RunAxeOptions = {},
): Promise<void> {
  const results = await runAxe(container, options);
  if (results.violations.length > 0) {
    throw new Error(
      `Found ${results.violations.length} accessibility violation(s):\n\n` +
        formatViolations(results.violations),
    );
  }
}
