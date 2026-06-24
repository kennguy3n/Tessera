# Quality gates: performance budgets, accessibility, visual regression

Tessera enforces three automated quality gates beyond the unit tests. All
three drive the **showcase-enabled production bundle** (`build:qa` →
`renderer-dist-qa/`) served by `vite preview`, so they exercise the real
shipped renderer against deterministic, seeded persona data — never
production data paths.

| Gate                     | What it covers                                              | Local command                                | CI                  |
| ------------------------ | ----------------------------------------------------------- | -------------------------------------------- | ------------------- |
| Cold-start perf          | Electron boot → first paint                                 | `npm run perf:cold-start`                    | `cold-start` job    |
| Interaction perf budgets | Heavy in-app surfaces (editors, concept-graph Canvas)       | `npm run perf:budgets`                       | `quality-gates` job |
| Accessibility (jsdom)    | All 10 pages + interactive surfaces, axe-core               | `npm run test --workspace=apps/desktop`      | `typescript` job    |
| Accessibility (browser)  | Same surfaces in light/dark/accent — colour-contrast + ARIA | `npm run qa:a11y --workspace=apps/desktop`   | `quality-gates` job |
| Visual regression        | Screenshot snapshots of every surface × theme               | `npm run qa:visual --workspace=apps/desktop` | `quality-gates` job |

The `quality-gates` CI job runs in the pinned Playwright container
(`mcr.microsoft.com/playwright:v1.60.0-jammy`) so the browser, OS libraries
and fonts are byte-identical to the environment the visual baselines were
captured in. **The image tag must match the `@playwright/test` version in
`package-lock.json` — bump both together.**

---

## A. Performance budgets

### Budgets are one config file

All budgets live in [`apps/desktop/qa/perf-budgets.json`](../apps/desktop/qa/perf-budgets.json)
— the single source of truth read by **both** perf gates:

```jsonc
{
  "coldStartMs": 2000, // boot → first paint (scripts/coldStartGate.cjs)
  "graphScale": 300, // concept-graph node count for the Canvas path
  "samples": 5, // measured runs per surface (median is compared)
  "warmup": 1, // discarded warmup runs before sampling
  "interaction": {
    // render-to-ready ceilings, ms (scripts/perfBudgets.mjs)
    "editor-document": 1200,
    "editor-sheet": 1050,
    "editor-base": 950,
    "editor-slides": 1100,
    "graph-canvas": 950,
  },
}
```

### How it measures

`scripts/perfBudgets.mjs` serves the QA bundle, then for each surface opens a
**fresh page** and reads the in-page `performance.now()` at the moment the
surface's "ready" DOM signal is true (plus two `requestAnimationFrame`s so the
first paint has committed). Because that clock's origin is the document's
navigation start, the number is the bundle-parse + mount + first-render cost of
that surface, measured **inside the page** — independent of Playwright IPC or
process-spawn latency. It reports the **median of N** runs after discarding
warmup runs, so a single GC pause can't trip the gate. No `sleep`s are used for
synchronisation — every wait is keyed to a real DOM signal.

The concept-graph Canvas renderer only engages at ≥ 220 nodes; the showcase
personas seed far fewer, so the harness drives it at scale via the QA-only
`?graphScale=<n>` bridge knob (deterministic synthetic graph, see
`showcaseGraphScaleFromQuery` in `renderer/src/showcase/index.ts`).

### Run it

```bash
npm run perf:budgets      # interaction/render budgets (needs build:qa first)
npm run perf:cold-start   # Electron boot budget
npm run perf              # both
```

`perf:budgets` requires `renderer-dist-qa/` to exist — run
`npm run build:qa --workspace=apps/desktop` first (the CI job does this).

### Reading a failure

Exit code `1` is a budget regression; `2` is a harness error (bundle missing,
server didn't start, a surface never reached its ready signal). Sample:

```
[perf-budgets] FAIL editor-document: median 405ms (budget 50ms) [405, 394, 419]
...
[perf-budgets] summary:
  FAIL editor-document    405ms /    50ms  (+355ms over budget)
  ok   editor-sheet       306ms /  1050ms
[perf-budgets] FAIL: 1 surface(s) over budget: editor-document (+355ms)
```

### Updating a budget

Budgets are ceilings set with headroom over the observed median on the CI
reference runner. After an intentional change that legitimately moves a median,
run `npm run perf:budgets` locally, read the reported medians, and bump the
relevant ceiling in `perf-budgets.json` **in the same PR** with a one-line
rationale in the commit message. Never loosen a budget to paper over a
regression — investigate the regression first.

---

## B. Accessibility

Two layers, because jsdom and a real browser catch different classes of bug:

- **jsdom (Vitest):** `renderer/src/__tests__/a11y/` runs axe-core (WCAG 2.1
  A/AA) over all 10 pages and the major interactive surfaces. Structural rules
  — heading order, roles/names, labels, ARIA relationships. Runs as part of
  `npm run test --workspace=apps/desktop`.
- **browser (Playwright):** `qa/a11y.spec.ts` runs axe-core over every surface
  in **light, dark, and an accent** theme (14 surfaces × 3 = 42 checks). This
  is what catches **colour-contrast** (jsdom has no layout/colour) and
  focus-visible/contrast issues that only exist against real computed styles.

```bash
npm run qa:a11y --workspace=apps/desktop      # browser pass (rebuilds QA bundle)
```

Violations are **fixed at the source**, not suppressed. A genuine
false-positive may be scoped with a documented `axe` exclusion and an inline
comment explaining why — there are currently none.

On failure, each violation is attached to the Playwright report as a readable
`axe-<surface>-<theme>.txt` with the rule, help URL, and the offending nodes.

---

## C. Visual regression

`qa/visual.spec.ts` captures a Playwright screenshot of every surface × theme
and diffs it against a committed baseline under
`qa/visual.spec.ts-snapshots/` (42 PNGs, `-linux` platform suffix).

### Determinism

Snapshots are only useful if they're stable. The harness pins everything that
would otherwise drift:

- Fixed **1440×900** viewport, `deviceScaleFactor: 1`, `--force-color-profile=srgb`.
- `reducedMotion: "reduce"` + Playwright's `animations: "disabled"` freeze
  transitions; the caret is hidden.
- The **page clock is pinned** to the showcase seed instant
  (`2026-05-12T15:04:00Z`) via `page.clock.setFixedTime`, so relative-time UI
  ("2h ago", "last backup …") renders identically every run.
- Seeded showcase persona data + deterministic concept-graph layout
  (phyllotaxis seed, no `Math.random`).
- Baselines are generated **inside the same Playwright container CI uses**, so
  font anti-aliasing matches.

### Run it / update baselines

```bash
npm run qa:visual --workspace=apps/desktop          # check against baselines
npm run qa:visual:update --workspace=apps/desktop   # re-record baselines
```

**Baselines must be regenerated in the pinned container** so they match CI.
The one-command flow:

```bash
docker run --rm -v "$PWD":/work -w /work/apps/desktop -e CI=1 \
  mcr.microsoft.com/playwright:v1.60.0-jammy \
  bash -c "npm run qa:visual:update"
```

Commit the updated PNGs in `qa/visual.spec.ts-snapshots/`. Review the diff
images in the Playwright report (`apps/desktop/playwright-report/`) before
committing to confirm the change is intended.

On failure the report contains `expected`, `actual`, and `diff` images for each
changed surface; the CI job uploads them as the `quality-gates-artifacts`
artifact.
