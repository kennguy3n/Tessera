/**
 * Dark-mode CSS-variable enforcement & regression test.
 *
 * Two checks:
 *
 * (1) Every `var(--color-…)` reference in the renderer source must
 *     resolve to a CSS custom property that is actually declared in
 *     tokens.css (i.e. the `var(name, fallback)` fallback should
 *     ONLY ever fire for an undeclared token while a designer is
 *     still wiring it up). Historically this codebase had a long
 *     tail of references to `--color-bg`, `--color-surface`,
 *     `--color-muted`, etc. that were never declared — their
 *     fallback colors fired in both light and dark mode, breaking
 *     dark theme silently. Task 26 added the aliases; this test
 *     pins them so a future refactor that drops one of the aliases
 *     surfaces immediately.
 *
 * (2) The `[data-theme="dark"]` block in tokens.css must override
 *     EVERY token that's reasonable for a theme to flip — at
 *     minimum the primary palette, the bg layer stack, the text
 *     stack, and the relevance / success / danger backgrounds. We
 *     don't try to enforce "every token must be overridden in dark"
 *     because some tokens (font sizes, spacing, radii) are
 *     theme-agnostic by design.
 *
 * The test is intentionally a regex sweep of the source, not a
 * DOM-based check, because JSDom doesn't compute getComputedStyle
 * for unknown custom properties — it just returns the empty string.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const RENDERER_SRC = resolve(__dirname, "..");
const TOKENS_CSS = resolve(__dirname, "../styles/tokens.css");

// Tokens that *intentionally* don't need to be declared because
// they target external libraries (Mermaid, Marp) whose stylesheets
// declare them under their own scope. Empty for now; placeholder so
// the allow-list grows by edit, not silently.
const ALLOWLIST: ReadonlySet<string> = new Set<string>([]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    if (entry === "__tests__") continue;
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (/\.(?:ts|tsx|css)$/.test(entry)) out.push(p);
  }
  return out;
}

function collectTokenRefs(): Set<string> {
  const re = /var\((--color-[a-z0-9-]+)/g;
  const refs = new Set<string>();
  for (const file of walk(RENDERER_SRC)) {
    const text = readFileSync(file, "utf8");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      refs.add(m[1]);
    }
  }
  return refs;
}

function readScopeBlock(scope: "root" | "dark" | "media-dark"): string {
  const text = readFileSync(TOKENS_CSS, "utf8");
  let blockText: string | undefined;
  // Regexes tolerate any amount of indentation before the closing
  // `}` so a future `prettier`/`stylelint` reformat that changes
  // whitespace won't silently break the test. Match the FIRST `}`
  // at the start of a line (after optional whitespace) — none of
  // these CSS blocks contain a nested block at the same depth, so
  // the non-greedy capture won't over-shoot.
  if (scope === "root") {
    blockText = text.match(/:root\s*\{([\s\S]*?)\n\s*\}/)?.[1];
  } else if (scope === "dark") {
    blockText = text.match(/\[data-theme="dark"\]\s*\{([\s\S]*?)\n\s*\}/)?.[1];
  } else {
    // The @media block wraps an inner `:root:not([data-theme=…])`
    // selector — extract just the inner declarations.
    blockText = text.match(
      /@media \(prefers-color-scheme: dark\)\s*\{[\s\S]*?\{([\s\S]*?)\n\s{2}\}/,
    )?.[1];
  }
  if (!blockText) {
    throw new Error(`tokens.css is missing the ${scope} selector`);
  }
  return blockText;
}

function collectDeclaredTokens(
  scope: "root" | "dark" | "media-dark",
): Set<string> {
  const blockText = readScopeBlock(scope);
  const declared = new Set<string>();
  const re = /(--color-[a-z0-9-]+)\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(blockText)) !== null) {
    declared.add(m[1]);
  }
  return declared;
}

/**
 * Collect `--color-*` token → declared value pairs from the given
 * CSS block scope. Values are normalized to lowercase + whitespace
 * collapsed so cosmetic edits (case of hex digits, spaces around
 * commas in `rgba(…)`) don't trigger spurious drift alarms; only
 * meaningful value diffs surface.
 */
function collectDeclaredTokenValues(
  scope: "root" | "dark" | "media-dark",
): Map<string, string> {
  const blockText = readScopeBlock(scope);
  const declared = new Map<string, string>();
  // Capture everything up to the line-terminating `;` so multi-arg
  // values like `rgba(0, 0, 0, 0.6)` are picked up whole.
  const re = /(--color-[a-z0-9-]+)\s*:\s*([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(blockText)) !== null) {
    const normalized = m[2].toLowerCase().replace(/\s+/g, " ").trim();
    declared.set(m[1], normalized);
  }
  return declared;
}

describe("dark-mode CSS variable enforcement", () => {
  it("every var(--color-…) reference in the renderer maps to a declared token", () => {
    const refs = collectTokenRefs();
    const declared = collectDeclaredTokens("root");
    const missing: string[] = [];
    for (const ref of refs) {
      if (ALLOWLIST.has(ref)) continue;
      if (!declared.has(ref)) missing.push(ref);
    }
    expect(
      missing,
      `These --color-* tokens are referenced in the renderer ` +
        `but NOT declared in :root of tokens.css. Their fallback ` +
        `color will fire in BOTH light and dark mode, silently ` +
        `breaking dark theme. Either add them to tokens.css or ` +
        `add them to the ALLOWLIST in this test file:\n${missing
          .map((n) => `  ${n}`)
          .join("\n")}`,
    ).toEqual([]);
  });

  it("[data-theme=\"dark\"] and @media (prefers-color-scheme: dark) declare the same tokens with identical values", () => {
    // that the explicit-Dark scope and the
    // System-Dark media query block are duplicated, and a future
    // patch could update one without the other — silently giving
    // users in System-Dark different colors than users who
    // selected Dark explicitly.
    //
    // We pin BOTH:
    //   (a) the same set of token *names* is declared, AND
    //   (b) each token resolves to the same normalized *value*.
    //
    // Name-set parity alone would let a maintainer update the hex
    // in one block but not the other and the test would still
    // pass; value parity catches that drift class too. Values are
    // normalized (lowercase + collapsed whitespace) so cosmetic
    // edits (uppercase hex, extra space in `rgba(…)`) don't trip
    // the test.
    const dark = collectDeclaredTokenValues("dark");
    const media = collectDeclaredTokenValues("media-dark");
    const onlyInDark = [...dark.keys()].filter((t) => !media.has(t));
    const onlyInMedia = [...media.keys()].filter((t) => !dark.has(t));
    const valueDrift: Array<{
      token: string;
      dark: string;
      media: string;
    }> = [];
    for (const [token, darkVal] of dark) {
      const mediaVal = media.get(token);
      if (mediaVal !== undefined && mediaVal !== darkVal) {
        valueDrift.push({ token, dark: darkVal, media: mediaVal });
      }
    }
    expect(
      { onlyInDark, onlyInMedia, valueDrift },
      `[data-theme="dark"] and @media (prefers-color-scheme: dark) ` +
        `must declare the same token set with identical values. ` +
        `Tokens that appear in one but not the other, or that have ` +
        `different values:\n  only in [data-theme]: ${JSON.stringify(
          onlyInDark,
        )}\n  only in @media: ${JSON.stringify(
          onlyInMedia,
        )}\n  value drift:\n${valueDrift
          .map(
            (d) =>
              `    ${d.token}: [data-theme]=${JSON.stringify(d.dark)} ` +
              `vs @media=${JSON.stringify(d.media)}`,
          )
          .join("\n")}`,
    ).toEqual({ onlyInDark: [], onlyInMedia: [], valueDrift: [] });
  });

  it("every primary palette / surface / text token is overridden in [data-theme=\"dark\"]", () => {
    // The contract: the dark scope must override every token
    // whose light-mode value would be wrong in dark mode. We pin
    // an explicit list rather than computing it because some
    // tokens (radii, font sizes) are theme-agnostic by design and
    // SHOULDN'T be in the dark scope.
    const REQUIRED_DARK_OVERRIDES = [
      "--color-primary",
      "--color-primary-hover",
      "--color-primary-light",
      "--color-bg-page",
      "--color-bg-surface",
      "--color-bg-sidebar",
      "--color-bg-secondary",
      "--color-text-headline",
      "--color-text-body",
      "--color-text-secondary",
      "--color-text-on-primary",
      "--color-border",
      "--color-border-light",
      // Tinted backgrounds where the light value mixes white with
      // the brand; left at light values they would clash on dark.
      "--color-danger-bg",
      "--color-danger-light",
      "--color-danger-subtle",
      "--color-success-bg",
      "--color-success-subtle",
      "--color-relevance-high-fg",
      "--color-relevance-high-bg",
      "--color-relevance-medium-fg",
      "--color-relevance-medium-bg",
      "--color-relevance-low-fg",
      "--color-relevance-low-bg",
      //  fix: --color-priority-high was added to
      // give the "high" priority badge a dedicated dark value
      // (#fb923c orange-400) for contrast on dark surfaces. If a
      // future patch drops the dark override, the badge silently
      // reverts to orange-700 which is unreadable on dark grey.
      "--color-priority-high",
    ];
    const dark = collectDeclaredTokens("dark");
    const missing = REQUIRED_DARK_OVERRIDES.filter((t) => !dark.has(t));
    expect(
      missing,
      `These tokens are declared in :root but NOT overridden in ` +
        `[data-theme="dark"]. They will retain their light values ` +
        `in dark mode, producing low-contrast UI:\n${missing
          .map((n) => `  ${n}`)
          .join("\n")}`,
    ).toEqual([]);
  });

  it("does NOT use bare #fff / #ffffff / white for body text or surfaces in inline styles", () => {
    // Sweep the renderer source for inline-style hardcoded white
    // colors that would persist into dark mode. Skip files whose
    // colors are intentionally user-data (e.g. Mermaid theme,
    // infographic / landing-page color-picker defaults that are
    // serialized into the artifact body and rendered into a
    // preview that DOES want a white background).
    const EXEMPT_FILES = new Set([
      "services/mermaidRenderer.ts",
      "services/iconResolver.ts",
      "editors/InfographicEditor.tsx",
      "editors/LandingPageEditor.tsx",
      "utils/cssColor.ts",
    ]);
    const violations: string[] = [];
    // Cover both styles of property name:
    //   • CSS kebab-case in *.css files: `color: "#fff"` /
    //     `background-color: "#fff"`
    //   • JSX camelCase in *.tsx files: `color: "#fff"` /
    //     `backgroundColor: "#fff"` / `borderColor: "#fff"`
    //
    // Anchor on a property-name boundary so the `color` alternative
    // doesn't accidentally match as a suffix of `backgroundColor`,
    // `borderColor`, etc. (the previous regex relied on that
    // accident — it).
    const re =
      /(?:(?:^|[\s,;{])(?:color|backgroundColor|background-color|background|borderColor|border-color))\s*:\s*["'](?:#fff(?:fff)?|white)["']/gim;
    for (const file of walk(RENDERER_SRC)) {
      const rel = file.slice(RENDERER_SRC.length + 1).replace(/\\/g, "/");
      if (EXEMPT_FILES.has(rel)) continue;
      const text = readFileSync(file, "utf8");
      if (re.test(text)) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
          violations.push(`${rel}: ${m[0]}`);
        }
      }
    }
    expect(
      violations,
      `Bare white-color inline styles found. Use ` +
        `var(--color-text-on-primary, #fff) (text on a colored bg) ` +
        `or var(--color-bg-page, #fff) (page surface) so dark mode ` +
        `can flip them:\n${violations.map((v) => `  ${v}`).join("\n")}`,
    ).toEqual([]);
  });
});
