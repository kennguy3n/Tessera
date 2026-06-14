/**
 * ESLint v9 flat config for the @tessera/desktop workspace.
 *
 * Migrated from `.eslintrc.cjs` (ESLint v8 legacy format) as part of
 * a tech-debt cleanup. The flat config format is
 * mandatory in ESLint v9 and supersedes the legacy `.eslintrc*` files.
 *
 * Composition (top to bottom, later configs override earlier ones for
 * matching files):
 *   1. `js.configs.recommended`                — ESLint core recommended ruleset
 *   2. `tseslint.configs.recommended`          — typescript-eslint v8 baseline (parser + rules)
 *   3. `reactHooks.configs["recommended-latest"]` — React hooks rules-of-hooks + exhaustive-deps
 *      (as a standalone config entry, not a `.rules` spread, so plugin
 *      registration and any future preset fields are picked up automatically)
 *   4. Project-specific overrides (TS)         — react-refresh + no-unused-vars convention,
 *      applied to every .ts/.tsx file in the workspace (modulo `ignores`),
 *      so any future TS root inherits the conventions without needing a
 *      config change. See the inline comment on the `files` array below.
 *   5. Project-specific overrides (JS)         — same `no-unused-vars` convention
 *      mirrored onto .js/.mjs/.cjs/.jsx files. The workspace currently
 *      authors only TS, but this block ensures the convention is truly
 *      workspace-wide and a future JS script inherits the same expectations.
 *
 * The `typescript-eslint` package re-exports both the parser and plugin under
 * a single helper namespace (`tseslint.configs.*`, `tseslint.config(...)`) so
 * the flat config doesn't need to manually wire `languageOptions.parser` and
 * `plugins['@typescript-eslint']`.
 */
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";

export default tseslint.config(
  {
    // Ignore-only block — ESLint v9 flat config has no `--ignore-path` /
    // `.eslintignore` mechanism, so all ignore patterns live here. Mirrors the
    // `ignorePatterns` field of the old `.eslintrc.cjs`, plus a few new
    // entries for build artifacts and config files (which we don't lint).
    ignores: [
      "dist/**",
      "dist-electron/**",
      // Vite renderer build output (`build.outDir` in vite.config.ts).
      // Sibling of `dist-electron/**` above; without it a local
      // `npm run build` before `npm run lint` makes ESLint try to
      // parse the minified production bundles and emit thousands of
      // spurious errors. CI never hits this because it lints before
      // building, but the local workflow does.
      "renderer-dist/**",
      // Parallel showcase-enabled renderer bundle (`build:qa`, used by the
      // a11y / visual-regression harness). Same reasoning as renderer-dist/**:
      // never lint the minified bundle.
      "renderer-dist-qa/**",
      "node_modules/**",
      // Build outputs from sub-workspaces (e.g. the extension's tsc emit)
      // happen to live inside `apps/desktop/node_modules/...` so they're
      // already excluded; but per-script test fixtures or generated mocks
      // could land here in the future.
      "coverage/**",
      // Build / test runner / lint config files are JS/TS but don't follow
      // the strict typing rules we apply to product code; let them through
      // type-check but skip lint to avoid noise. Vitest doesn't have its
      // own config file — its `test:` block lives inside `vite.config.ts`
      // (the canonical Vite + Vitest setup), so the one Vite entry below
      // covers both build and test-runner config.
      "vite.config.ts",
      "eslint.config.mjs",
    ],
  },
  // Core ESLint recommended rules — applied to all linted files
  // (overridden file-by-file via `files` below where needed).
  js.configs.recommended,
  // typescript-eslint v8 baseline. The `recommended` preset is intentionally
  // chosen over `recommendedTypeChecked` to avoid the cost of a full
  // type-aware parse (the project already has a separate `npm run type-check`
  // that runs the full TypeScript compiler). Type-aware lint rules
  // (`no-floating-promises`, `no-misused-promises`, etc.) are valuable but
  // add ~10x to lint runtime and would be better introduced as a separate
  // tech-debt PR once the migration is stable.
  ...tseslint.configs.recommended,
  // react-hooks v5 flat-config — applied as a standalone config entry rather
  // than spreading only `.rules` into our override block. The standalone form
  // is the canonical pattern: it picks up the plugin registration AND any
  // future fields the preset may add (e.g. `languageOptions`, `settings`) so
  // we don't silently drop hooks-lint coverage on a plugin upgrade. The
  // `rules-of-hooks` and `exhaustive-deps` rules don't fire on non-React code,
  // so applying globally is safe.
  reactHooks.configs["recommended-latest"],
  {
    // Project-specific overrides. Applied to ALL TS/TSX files (not just the
    // three product roots in `renderer/src/`, `electron/`, `shared/`) so the
    // project's underscore-prefix `no-unused-vars` convention and the
    // `react-refresh/only-export-components` rule cover any new TS directory
    // a future contributor adds — e.g. a top-level `scripts/`, `tools/`, or
    // `tests-e2e/` folder. The build-artifact / generated-config exclusions
    // are handled by the `ignores` block above; everything else under the
    // workspace that we author should follow these conventions.
    //
    // Devin Review on PR #67 (`ANALYSIS_pr-review-job-...0001`) flagged the
    // earlier three-root `files` array as a footgun: any future TS file added
    // outside those roots would silently lose the project conventions and
    // pick up only the typescript-eslint v8 baseline. Round 6
    // (`ANALYSIS_pr-review-job-...0002`) followed up: extended the glob to
    // include `.cts` and `.mts` so the override matches the exact set of
    // extensions that `tseslint.configs.recommended` parses
    // (`.ts/.tsx/.cts/.mts`). Without `.cts`/`.mts`, a future CommonJS-style
    // TypeScript file (e.g. a build script using top-level `require()`) or
    // an ESM-style one (e.g. a module that needs to opt out of the
    // package-level `"type"` setting) would get the typescript-eslint
    // baseline `no-unused-vars` but NOT the project's underscore-prefix
    // convention.
    files: ["**/*.{ts,tsx,cts,mts}"],
    languageOptions: {
      ecmaVersion: 2020,
      // `sourceType: "module"` is correct for `.ts`, `.tsx`, and `.mts`
      // (all ESM by convention). For `.cts` files (TypeScript's
      // CommonJS-syntax counterpart of `.cjs`), the next block overrides
      // this to `"script"` so the AST `sourceType` field reflects the
      // file's actual module type. The override is deliberately
      // placed as a separate config block (rather than narrowing this
      // glob to exclude `.cts`) because every other field of this
      // block — globals, plugins, rules — applies identically to `.cts`
      // files and a narrowed glob would duplicate ~50 lines for one
      // setting. The flat-config merge rule (later configs override
      // earlier ones for matching files) means the override below
      // only changes `sourceType`; everything else here cascades.
      //
      // Round 7 finding (`BUG_pr-review-job-...0001`): the previous
      // revision set `sourceType: "module"` for ALL four extensions,
      // which would force ESM parsing on any future `.cts` file. Caught
      // as the asymmetric counterpart of the Round 6 JS-block fix.
      sourceType: "module",
      // Both renderer (browser) and electron (node) globals are needed
      // because the lint scope spans both processes. The `es2020` group
      // covers Promise, Symbol, Map/Set, etc. that show up in both.
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2020,
      },
    },
    plugins: {
      // `react-hooks` is already registered by the standalone
      // `recommended-latest` config block above. `react-refresh` is the only
      // plugin that needs to be wired up by this override block (the v0.4.x
      // line of `eslint-plugin-react-refresh` doesn't export a flat-config
      // preset, so the plugin is registered and the rule configured manually
      // here).
      "react-refresh": reactRefresh,
    },
    rules: {
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
      // Disable the core `no-unused-vars` in favour of the typescript-eslint
      // version (already applied by `tseslint.configs.recommended` but
      // overridden here with the project's underscore-prefix convention).
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          // The codebase uses an `_`-prefix convention to mark
          // intentionally-unused bindings. Apply that convention
          // uniformly across every binding kind (function args,
          // top-level vars, destructured locals, array-destructured
          // elements, caught errors), not just function args as the
          // original config did. Without the four ignore patterns
          // below, idioms like
          // `const { x: _ignored, ...rest } = obj` (used in
          // `schemas.test.ts` to assert "this schema rejects when
          // `x` is missing") fired warnings even though the leading
          // underscore signalled deliberate non-use.
          //
          // Deliberately NOT setting `ignoreRestSiblings: true`. That
          // option silences every destructured sibling of a `...rest`
          // spread regardless of name, which would also hide genuine
          // unused bindings like `const { secret, ...rest } = obj`
          // where the contributor forgot to consume `secret`. The
          // four `^_` patterns above are sufficient to cover the
          // deliberate "discard this field" idiom — the rest-spread
          // pattern in `schemas.test.ts` already follows the
          // underscore convention and is matched by
          // `varsIgnorePattern`.
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    // `.cts` (TypeScript CommonJS) override. The block above sets
    // `sourceType: "module"` for `**/*.{ts,tsx,cts,mts}` because the
    // overwhelming majority of TS in the workspace is ESM and lives in
    // `.ts`/`.tsx`. But `.cts` files are semantically CommonJS (the TS
    // counterpart of `.cjs`) — top-level `require()` and `module.exports`
    // are expected, top-level `import`/`export` is not. Forcing an ESM
    // `sourceType` on these files would misrepresent their structure in
    // the AST and could mis-trigger rules that inspect `sourceType`
    // (e.g. `no-undef` for the CommonJS `module` / `exports` / `require`
    // globals).
    //
    // The override only changes `sourceType`; every other field
    // (ecmaVersion, globals, plugins, rules) cascades from the block
    // above per flat-config's merge semantics. `"script"` is used
    // because @typescript-eslint/parser only accepts `"module"` or
    // `"script"` as valid `sourceType` values (it coerces anything else,
    // including `"commonjs"`, to `"script"`) — see
    // node_modules/.../parser/dist/parser.js line ~75.
    //
    // Round 7 finding (`BUG_pr-review-job-...0001`): the bot suggested
    // simply omitting `sourceType` from the TS block to mirror the
    // Round 6 JS-block fix. That would have broken every existing
    // `.ts`/`.tsx` file in the workspace because typescript-eslint's
    // parser defaults to `"script"` when `sourceType` is unset (unlike
    // core ESLint v9, which infers from extension). The correct
    // architectural fix is this per-extension override block.
    files: ["**/*.cts"],
    languageOptions: {
      sourceType: "script",
    },
  },
  {
    // JavaScript-file parallel of the project conventions above. The workspace
    // currently authors only TypeScript (the only non-ignored `.js`/`.mjs`/
    // `.cjs` file today is `eslint.config.mjs` itself, which is excluded by
    // the `ignores` block), but this block ensures that if a future
    // contributor adds a top-level `.js` script (e.g. a migration or build
    // helper), it inherits the same underscore-prefix `no-unused-vars`
    // convention as the TS code — not just the `js.configs.recommended`
    // baseline with its default `no-unused-vars` configuration.
    //
    // Devin Review on PR #67 (`ANALYSIS_pr-review-job-...0001`, follow-up to
    // the three-root → workspace-wide fix in commit 51b7e8e) flagged the
    // remaining JS gap. The `@typescript-eslint/no-unused-vars` rule above
    // doesn't cover non-TS files (typescript-eslint's `recommended` preset
    // gates itself to `.ts/.tsx/.cts/.mts`), so the JS side needs the core
    // `no-unused-vars` configured separately with the matching ignore
    // patterns.
    files: ["**/*.{js,mjs,cjs,jsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      // Deliberately NOT setting `sourceType` — ESLint v9's flat config
      // infers it from the file extension: `.cjs` → `"commonjs"`, `.mjs`
      // and `.js`/`.jsx` (in a `"type": "module"` package) → `"module"`.
      // Round 6 (`ANALYSIS_pr-review-job-...0001`) caught the earlier
      // explicit `sourceType: "module"` override here: it would have
      // forced ESM parsing on any future `.cjs` file, misparsing
      // `require()` and `module.exports`. Letting ESLint's per-extension
      // inference do the right thing automatically is both safer and
      // matches the canonical flat-config pattern.
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2020,
      },
    },
    rules: {
      "no-unused-vars": [
        "warn",
        {
          // Mirrors the four ignore patterns on
          // `@typescript-eslint/no-unused-vars` above. See that rule's
          // block comment for the rationale on why all four patterns are
          // required (and why `ignoreRestSiblings: true` is deliberately
          // not set).
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
    },
  },
);
