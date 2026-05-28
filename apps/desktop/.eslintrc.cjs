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
        // top-level vars, destructured locals, caught errors), not
        // just function args as the original config did. Without the
        // four ignore patterns below, idioms like
        // `const { x: _ignored, ...rest } = obj` (used in
        // `schemas.test.ts` to assert "this schema rejects when
        // `x` is missing") fired warnings even though the leading
        // underscore signalled deliberate non-use.
        //
        // `ignoreRestSiblings: true` is a defence-in-depth pairing
        // for the rest-spread pattern above: even if a future
        // contributor forgets the `_` prefix, destructuring a key
        // *adjacent* to a `...rest` is by construction "extract one
        // field to discard it", and warning on the discarded sibling
        // is noise that hides real unused-binding bugs.
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
        destructuredArrayIgnorePattern: "^_",
        ignoreRestSiblings: true,
      },
    ],
  },
};
