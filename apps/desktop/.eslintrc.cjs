module.exports = {
  root: true,
  env: { browser: true, es2020: true, node: true },
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:react-hooks/recommended",
  ],
  ignorePatterns: ["dist", "dist-electron", ".eslintrc.cjs"],
  parser: "@typescript-eslint/parser",
  plugins: ["react-refresh"],
  rules: {
    "react-refresh/only-export-components": [
      "warn",
      { allowConstantExport: true },
    ],
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
};
