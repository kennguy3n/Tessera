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
 *     dark theme silently. The dark-mode hardening pass added the
 *     aliases; this test pins them so a future refactor that drops
 *     one of the aliases surfaces immediately.
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
    // The explicit-Dark scope and the System-Dark media query block
    // are duplicated, and a future patch could update one without
    // the other — silently giving users in System-Dark different
    // colors than users who selected Dark explicitly.
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
      // --color-priority-high was added to give the "high" priority
      // badge a dedicated dark value (#fb923c orange-400) for
      // contrast on dark surfaces. If a
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
    // accident).
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

  it("KChat citation surface classes are styled with theme tokens (Phase 13 Theme 5 Task 29)", () => {
    // The KChat-specific class names below ship with markup in
    // `CitationPanel.tsx` (Phase 13 Themes 1–4) but lived without
    // any CSS rules until Theme 5 — meaning the surface rendered
    // as undecorated inline text in BOTH light and dark themes.
    // This test pins three invariants of the Theme 5 patch:
    //
    //   (i)  Every class in the list below has a rule in
    //        `components.css` (no silent drop of styling).
    //   (ii) Every rule uses ONLY `var(--color-…)` token
    //        references for color-bearing properties (no bare
    //        `#hex` / `rgb(...)` / `hsl(...)`). Token references
    //        re-evaluate per scope, so dark mode picks up the
    //        override scope in `tokens.css` automatically — a
    //        bare hex would silently persist into dark mode and
    //        break the visual contract.
    //   (iii) Every token referenced is one that IS overridden in
    //        the dark scope (per the REQUIRED_DARK_OVERRIDES list
    //        above) OR is one of the "intentionally theme-agnostic
    //        but visually-safe in both" tokens
    //        (--color-success / --color-warning / --color-error /
    //        --color-text-link, all of which have colorimetric
    //        readability on both light and dark surfaces — pinned
    //        independently by the must-override test below).
    const COMPONENTS_CSS = resolve(__dirname, "../styles/components.css");
    const text = readFileSync(COMPONENTS_CSS, "utf8");

    const KCHAT_SURFACE_CLASSES = [
      "citation-source-badge",
      "citation-source-badge-kchat",
      "citation-item-kchat",
      "citation-search-hit-kchat",
      "citation-hit-kchat-channel",
      "citation-hit-kchat-sender",
      "citation-hit-kchat-timestamp",
      "citation-hit-kchat-permalink",
    ];

    // (i) every class has a rule (selector appears in the
    // stylesheet, anchored as a class selector — `.foo` followed
    // by `{`, `,`, ` `, or `:` so we don't match a substring
    // of a longer class).
    const missing: string[] = [];
    for (const cls of KCHAT_SURFACE_CLASSES) {
      const re = new RegExp(`\\.${cls}(?=[\\s,:{])`);
      if (!re.test(text)) missing.push(cls);
    }
    expect(
      missing,
      `KChat citation surface classes missing from components.css. ` +
        `CitationPanel.tsx references these classes but they have ` +
        `no CSS rules — surface renders as undecorated text in ` +
        `both light and dark mode:\n${missing.map((c) => `  .${c}`).join("\n")}`,
    ).toEqual([]);

    // (ii) collect every rule body for these class selectors and
    // assert no bare hex / rgb / hsl color values. Match the
    // selector group up to the next `{`, then the body up to the
    // matching `}`.
    const bareColorViolations: string[] = [];
    for (const cls of KCHAT_SURFACE_CLASSES) {
      // Match the rule body. Selectors can include the class plus
      // optional pseudo (e.g. `.citation-hit-kchat-permalink:hover`)
      // — allow non-`{` chars before the opening brace.
      const ruleRe = new RegExp(
        `\\.${cls}[^{]*\\{([^}]*)\\}`,
        "g",
      );
      let m: RegExpExecArray | null;
      while ((m = ruleRe.exec(text)) !== null) {
        const body = m[1];
        // Look for any color-bearing property whose value is a bare
        // color literal. The first capture group is the offending
        // value; we surface both class + value for easy fixing.
        const bareRe =
          /(?:background-color|background|color|border|border-color|outline|outline-color|fill|stroke)\s*:\s*([^;}]*)/g;
        let mm: RegExpExecArray | null;
        while ((mm = bareRe.exec(body)) !== null) {
          const value = mm[1].trim();
          // Allow `none`, theme-token references, calc(), and
          // composite border shorthand whose color component is a
          // token (caught by the inner var() check). Reject any
          // literal hex / rgb / hsl / named-color value.
          if (/#[0-9a-fA-F]{3,8}\b/.test(value)) {
            bareColorViolations.push(`.${cls} → ${mm[0].trim()}`);
            continue;
          }
          if (/\brgba?\s*\(/.test(value)) {
            bareColorViolations.push(`.${cls} → ${mm[0].trim()}`);
            continue;
          }
          if (/\bhsla?\s*\(/.test(value)) {
            bareColorViolations.push(`.${cls} → ${mm[0].trim()}`);
            continue;
          }
        }
      }
    }
    expect(
      bareColorViolations,
      `KChat surface CSS rules use bare color literals instead of ` +
        `theme tokens. Use var(--color-…) so dark mode picks up ` +
        `the override:\n${bareColorViolations.map((v) => `  ${v}`).join("\n")}`,
    ).toEqual([]);

    // (iii) every token referenced inside one of these rules must
    // either be in the must-override-dark list OR an accent token
    // whose light value remains readable in dark (success / warning
    // / error / text-link / primary). Reject any unrecognised token.
    const SAFE_TOKENS = new Set<string>([
      // Must-override list (declared above in this file).
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
      "--color-danger-bg",
      "--color-danger-light",
      "--color-danger-subtle",
      "--color-success-bg",
      "--color-success-subtle",
      // Theme-agnostic accents that are readable on both surfaces.
      "--color-success",
      "--color-warning",
      "--color-error",
      "--color-text-link",
    ]);
    const unknownTokens: string[] = [];
    for (const cls of KCHAT_SURFACE_CLASSES) {
      const ruleRe = new RegExp(
        `\\.${cls}[^{]*\\{([^}]*)\\}`,
        "g",
      );
      let m: RegExpExecArray | null;
      while ((m = ruleRe.exec(text)) !== null) {
        const body = m[1];
        const tokenRe = /var\((--color-[a-z0-9-]+)/g;
        let tm: RegExpExecArray | null;
        while ((tm = tokenRe.exec(body)) !== null) {
          if (!SAFE_TOKENS.has(tm[1])) {
            unknownTokens.push(`.${cls} → var(${tm[1]})`);
          }
        }
      }
    }
    expect(
      unknownTokens,
      `KChat surface CSS rules reference color tokens that are NOT ` +
        `in the dark-mode-safe allow list. Either pick a token from ` +
        `the safe set or document why this one is dark-safe and ` +
        `add it to SAFE_TOKENS:\n${unknownTokens.map((v) => `  ${v}`).join("\n")}`,
    ).toEqual([]);
  });
});
