/**
 * ESLint v9 flat config for the @tessera/desktop workspace.
 *
 * Migrated from `.eslintrc.cjs` (ESLint v8 legacy format) as part of
 * the Phase 14 tech-debt cleanup PR 3 of 3. The flat config format is
 * mandatory in ESLint v9 and supersedes the legacy `.eslintrc*` files.
 *
 * Composition (top to bottom, later configs override earlier ones for
 * matching files):
 *   1. `js.configs.recommended`              — ESLint core recommended ruleset
 *   2. `tseslint.configs.recommended`        — typescript-eslint v8 baseline (parser + rules)
 *   3. `reactHooks.configs.recommended-latest` — React hooks rules-of-hooks + exhaustive-deps
 *   4. Project-specific overrides           — react-refresh + no-unused-vars convention
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
      "node_modules/**",
      // Build outputs from sub-workspaces (e.g. the extension's tsc emit)
      // happen to live inside `apps/desktop/node_modules/...` so they're
      // already excluded; but per-script test fixtures or generated mocks
      // could land here in the future.
      "coverage/**",
      // Vite & test runner config files are JS/TS but don't follow the
      // strict typing rules we apply to product code; let them through
      // type-check but skip lint to avoid noise.
      "vite.config.ts",
      "vitest.config.ts",
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
  {
    // Apply lint rules only to product TS/TSX files in the three roots
    // (renderer source, electron main process, shared types). The original
    // lint script in `package.json` enumerated these as CLI globs; moving
    // them into `files` here lets `eslint .` find everything correctly
    // and centralises the file scope so future scope changes touch this
    // file rather than `package.json`.
    files: [
      "renderer/src/**/*.{ts,tsx}",
      "electron/**/*.ts",
      "shared/**/*.ts",
    ],
    languageOptions: {
      ecmaVersion: 2020,
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
      // The react-hooks v5 plugin's flat-config export is the
      // `recommended-latest` config; we apply it via the spread below.
      // Keeping the plugin registered here in case future overrides need to
      // address individual hook rules by name.
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs["recommended-latest"].rules,
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
);
