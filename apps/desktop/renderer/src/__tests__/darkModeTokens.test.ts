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

// Tokens whose light value would be wrong in dark mode and that
// MUST be overridden in the dark scope. Declared at describe-level
// so the must-override test (below) and the KChat-surface
// dark-mode-safe-tokens test (further below) can share the same
// single source of truth — Devin Review (PR #55,
// flagged that duplicating this list inside the KChat test would
// silently diverge if a future patch added a token to one list
// but not the other.
const REQUIRED_DARK_OVERRIDES: readonly string[] = [
  "--color-primary",
  "--color-primary-hover",
  // --color-primary-active darkens the accent toward black in light
  // mode but must lighten it toward white on dark surfaces (the button
  // :active state). Both dark scopes override it; pin it so a future
  // patch can't drop the override and leave the press state using the
  // light-mode darkened accent on a dark surface.
  "--color-primary-active",
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
  // contrast on dark surfaces. If a future patch drops the dark
  // override, the badge silently reverts to orange-700 which is
  // unreadable on dark grey.
  "--color-priority-high",
  // Warning surface tokens. The pre-existing `.badge-warning`
  // surface used bare hex literals that didn't flip; we point
  // it at these tokens now and pin the dark override here.
  // Pass-5 dropped a speculative `-subtle` variant
  // that had no consumer — we only pin tokens that actually
  // ship a consumer, so a future patch that adds an unused
  // token fails the must-override test at the same time as the
  // unused-token reviewer surfaces the gap.
  "--color-warning-bg",
  "--color-warning-fg",
  // success/danger badge & toast foregrounds. Without dark
  // overrides the historic light-on-light pairing (#065f46 on
  // #d1fae5, #991b1b on #fee2e2) would persist into dark mode.
  "--color-success-fg",
  "--color-danger-fg",
  // --color-text-link DOES have a dark override in both the
  // `[data-theme="dark"]` scope (tokens.css:138) and the
  // `@media (prefers-color-scheme: dark)` scope (tokens.css:175).
  // Per Devin Review PR #55 it belongs in the
  // must-override list — earlier shape mistakenly classified it
  // as "theme-agnostic". Moving it here keeps the test name
  // accurate (token IS overridden in dark, so it MUST stay
  // overridden).
  "--color-text-link",
  // Modal/dialog scrim. The light value is a near-black tint with
  // alpha; the dark scopes deepen it (#000000 66%) so the overlay
  // reads against dark surfaces. Pin it so the override can't be
  // dropped, which would leave a too-light scrim in dark mode.
  "--color-overlay",
];

// Theme-agnostic accent tokens whose light values remain
// readable on both light and dark surfaces (success / warning /
// error). They are intentionally NOT in
// REQUIRED_DARK_OVERRIDES because forcing a dark override would
// reduce contrast — the light values are calibrated to work on
// both palettes. Centralising them here lets the KChat-surface
// dark-mode-safe test extend the must-override allow list
// without duplicating either list.
const THEME_AGNOSTIC_ACCENT_TOKENS: readonly string[] = [
  "--color-success",
  "--color-warning",
  "--color-error",
];

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
    // an explicit list (`REQUIRED_DARK_OVERRIDES`, declared at
    // module scope) rather than computing it because some tokens
    // (radii, font sizes) are theme-agnostic by design and
    // SHOULDN'T be in the dark scope.
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

  it("KChat citation surface classes are styled with theme tokens", () => {
    // The KChat-specific class names below ship with markup in
    // `CitationPanel.tsx`  but lived without
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
    //
    // The selector regex anchors the class name with a
    // lookahead (`(?=[\s,:{])`) so a bare `.citation-source-badge`
    // does NOT also match `.citation-source-badge-kchat` (the
    // `[^{]*` segment would otherwise consume the `-kchat ` suffix
    // and the rule body would be misattributed to the base class).
    // Per Devin Review PR #55. The lookahead also
    // tolerates pseudo-classes (`.citation-hit-kchat-permalink:hover`)
    // because the `[^{]*` after the lookahead happily consumes
    // them.
    const bareColorViolations: string[] = [];
    for (const cls of KCHAT_SURFACE_CLASSES) {
      const ruleRe = new RegExp(
        `\\.${cls}(?=[\\s,:{])[^{]*\\{([^}]*)\\}`,
        "g",
      );
      let m: RegExpExecArray | null;
      while ((m = ruleRe.exec(text)) !== null) {
        const body = m[1];
        // Look for any color-bearing property whose value is a bare
        // color literal. The first capture group is the offending
        // value; we surface both class + value for easy fixing.
        //
        // Include the directional border shorthands (border-left /
        // border-right / border-top / border-bottom) explicitly —
        // the bare `border` alternative does NOT match
        // `border-left:` because the `\s*:\s*` segment fails on
        // `-left:`. Without these alternatives, a future regression
        // that replaces `border-left: 3px solid var(--color-primary)`
        // with `border-left: 3px solid #7c3aed` would silently pass
        // this check. Per Devin Review PR #55.
        const bareRe =
          /(?:background-color|background|color|border-left|border-right|border-top|border-bottom|border-color|border|outline-color|outline|fill|stroke)\s*:\s*([^;}]*)/g;
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
    // either be in the must-override-dark list OR a theme-agnostic
    // accent whose light value remains readable in dark
    // (success / warning / error / text-link). Derived from the
    // describe-level `REQUIRED_DARK_OVERRIDES` and
    // `THEME_AGNOSTIC_ACCENT_TOKENS` constants so there is exactly
    // one source of truth: a future patch that adds a token to
    // either list automatically extends the dark-mode-safe surface
    // here, with no manual sync. Per Devin Review (PR #55,
    const SAFE_TOKENS = new Set<string>([
      ...REQUIRED_DARK_OVERRIDES,
      ...THEME_AGNOSTIC_ACCENT_TOKENS,
    ]);
    // Use the same lookahead-anchored regex as sub-test (ii) above
    // — a bare `.citation-source-badge` should NOT pick up the body
    // of `.citation-source-badge-kchat` when collecting token
    // references, or a non-safe token added to the modifier rule
    // would be misattributed to the base class. Per Devin Review
    // PR #55 BUG_pr-review-job-6ef624e58fa8479f8ed64e27537debce_0001
    // (a follow-up to Pass-3 which fixed the (ii)
    // sub-test regex but missed this one).
    const unknownTokens: string[] = [];
    for (const cls of KCHAT_SURFACE_CLASSES) {
      const ruleRe = new RegExp(
        `\\.${cls}(?=[\\s,:{])[^{]*\\{([^}]*)\\}`,
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
