/**
 * Phase verification smoke test (renderer side).
 *
 * This suite enforces the Phase 7/8 tracking-integrity guarantee: every
 * feature claimed in PROGRESS.md must be backed by real, importable code
 * — not just documentation or a checked checkbox. The suite intentionally
 * skips behavioural depth (those checks live in the focused unit tests
 * under apps/desktop/renderer/src/__tests__/) and instead enforces the
 * structural surface: the rendering services exist, the editors are
 * barrel-exported, and every CATEGORIES entry in CreatePage.tsx maps to
 * a bundled YAML template id.
 *
 * Companion suites verify the Rust side:
 *   - crates/tessera_templates/tests/phase_smoke_templates.rs
 *     (every YAML loads + validates)
 *   - crates/tessera_connectors/tests/phase_smoke_connectors.rs
 *     (every connector exposes its OAuth / sync / revoke surface)
 *   - crates/tessera_export/tests/phase_smoke_export.rs
 *     (every export module exposes its top-level function)
 *
 * The combined entrypoint that runs every smoke check is
 * `npm run test:smoke` (defined at the repo root).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { describe, expect, test } from "vitest";

import * as mermaidRenderer from "../../services/mermaidRenderer";
import * as marpRenderer from "../../services/marpRenderer";
import * as iconResolver from "../../services/iconResolver";
import * as editors from "../../editors";

// Repository root — six directory levels up from this test file.
// The file lives at:
//   apps/desktop/renderer/src/__tests__/smoke/phaseVerification.test.ts
// so resolving six `..` segments walks back through, in order:
//   smoke -> __tests__ -> src -> renderer -> desktop -> apps -> <root>.
// We resolve via __dirname rather than hardcoding so the test runs the
// same on every contributor's box. If the test file is ever relocated
// (e.g. promoted to a top-level tests/ directory), this count and the
// comment must be updated together.
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..", "..", "..");
const TEMPLATES_DIR = join(REPO_ROOT, "templates");

// Categories we expect under templates/. If a new artifact type lands,
// add it here and add a section parser below — the
// `every templates/ subdirectory is a classified category` test below
// dynamically enumerates the actual subdirectories at test time and
// fails loudly if any are missing from this list (or NON_TEMPLATE_DIRS).
//
// NOTE: `templates/grammars/` is intentionally classified separately,
// in NON_TEMPLATE_DIRS, because it holds GBNF grammar files (`.gbnf`)
// that constrain LLM output for structured generation — it is not a
// template category. The walker below filters on the `.yaml`/`.yml`
// extension anyway, so even if a stray `.gbnf` ended up under one of
// the listed categories it would be skipped, but keeping the exclusion
// explicit means a future contributor reading these lists isn't left
// wondering whether `grammars/` was an oversight.
const TEMPLATE_CATEGORIES = [
  "documents",
  "slides",
  "sheets",
  "bases",
  "infographics",
  "landing_pages",
] as const;

// Subdirectories under `templates/` that are NOT template categories.
// Currently just `grammars/`. Mirrors `NON_TEMPLATE_DIRS` in the Rust
// smoke test (`crates/tessera_templates/tests/phase_smoke_templates.rs`).
// If a future addition lands (e.g. `templates/shared/` for reusable
// fragments), classify it here so the dynamic-discovery test still
// passes without silently waving in a new template category.
const NON_TEMPLATE_DIRS = ["grammars"] as const;

interface BundledTemplate {
  id: string;
  /** Path relative to repo root, for diagnostic output. */
  relPath: string;
  /** Top-level `type` field — used to sanity-check the category dir. */
  type?: string;
}

/**
 * Walk `templates/<category>/` recursively and extract the top-level
 * `id` (and, if present, `type`) field from every `.yaml` / `.yml`
 * file. Recursion picks up future locale subdirectories
 * (e.g. `templates/documents/locales/es/prd.yaml`).
 *
 * We deliberately do NOT depend on a YAML library on the renderer
 * side. The rigorous full-document parse (serde_yaml) runs in the
 * Rust smoke test (`crates/tessera_templates/tests/phase_smoke_*.rs`).
 * Here we only need `id` and `type`, and Tessera's bundled templates
 * write both as top-level scalar fields on their own line — so a
 * straightforward line-by-line scanner is both correct and avoids
 * pulling a YAML parser into the renderer's dev-deps.
 */
function loadBundledTemplates(): BundledTemplate[] {
  const out: BundledTemplate[] = [];
  for (const category of TEMPLATE_CATEGORIES) {
    const root = join(TEMPLATES_DIR, category);
    const stack: string[] = [root];
    while (stack.length) {
      const dir = stack.pop()!;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        // The category directory may not exist yet on an older
        // checkout; skip silently and let the count assertion below
        // be the source of truth.
        continue;
      }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (!e.isFile()) continue;
        if (!e.name.endsWith(".yaml") && !e.name.endsWith(".yml")) continue;
        const body = readFileSync(full, "utf8");
        const relPath = full.replace(REPO_ROOT + sep, "");
        const id = extractTopLevelScalar(body, "id");
        if (!id) {
          throw new Error(
            `Bundled template ${relPath} is missing a top-level "id" field`,
          );
        }
        out.push({
          id,
          relPath,
          type: extractTopLevelScalar(body, "type") ?? undefined,
        });
      }
    }
  }
  return out;
}

/**
 * Pull a scalar value out of a YAML document by looking for a
 * top-level (non-indented) line matching `<key>:`. Returns the value
 * with surrounding quotes stripped, or null if the key is absent.
 *
 * The unquoted-comment-stripping rule mirrors YAML 1.2 §6.6: a `#`
 * only begins a comment when preceded by whitespace (or appears at
 * the start of the line). So `id: foo#bar` is the literal value
 * `foo#bar`, while `id: foo # comment` is the literal value `foo`
 * with a trailing comment. A naïve lazy-regex like `(.*?)\s*(?:#.*)?$`
 * would incorrectly truncate `id: foo#bar` to `foo`, because the lazy
 * quantifier prefers the shortest match that still lets the optional
 * comment tail succeed.
 *
 * We instead split the line manually on `<key>:` and use a small
 * state machine to find the start of a real comment, honouring both
 * single- and double-quoted scalars (where `#` is literal).
 */
function extractTopLevelScalar(body: string, key: string): string | null {
  const lines = body.split(/\r?\n/);
  const prefix = `${key}:`;
  for (const line of lines) {
    // Top-level keys begin in column 0; indented occurrences belong to
    // nested mappings and must be ignored.
    if (/^\s/.test(line)) continue;
    if (!line.startsWith(prefix)) continue;
    // Skip the `<key>:` then trim only the inter-token whitespace —
    // do NOT consume trailing whitespace yet, because the unquoted
    // value may legitimately contain a `#` that is not a comment.
    let rest = line.slice(prefix.length);
    // Eat single space/tab run after the colon. Anything beyond a
    // single column of inter-token whitespace is unusual for our
    // bundled templates but YAML permits it.
    rest = rest.replace(/^[\t ]+/, "");
    // Quoted scalar — the value lives between the quotes and any
    // trailing text on the line (including `#`) is comment. Escape
    // conventions differ between the two flavours:
    //
    //   * Double-quoted (YAML 1.2 §7.3.1): C-style backslash escapes
    //     (`\n`, `\t`, `\"`, `\\`, `\uXXXX`, etc.). We don't need to
    //     fully decode these for our limited use case (template ids
    //     and types) — we just need to know that a backslash protects
    //     the next character, so a `\"` in the middle of the scalar
    //     is not the closing quote.
    //
    //   * Single-quoted (YAML 1.2 §7.3.2): the ONLY escape is the
    //     literal sequence `''` (two consecutive single quotes),
    //     which represents one literal `'`. No backslash escapes
    //     apply. So `'it''s'` decodes to `it's`. This was the gap
    //     Devin Review round-6 flagged — the previous lexer would
    //     stop at the first `'` and incorrectly return `it`.
    //
    // We accumulate the decoded value as we go so the returned
    // string is the actual scalar content, not the raw slice between
    // the quote characters.
    if (rest.startsWith('"') || rest.startsWith("'")) {
      const quote = rest[0];
      let i = 1;
      const decoded: string[] = [];
      let terminated = false;
      while (i < rest.length) {
        const c = rest[i];
        if (c === "\\" && quote === '"') {
          // Double-quoted backslash escape: pass through the next
          // character verbatim. (For our purposes — ids and types
          // are ASCII identifiers — this is sufficient. Full YAML
          // escape decoding would substitute the escape's meaning
          // here, but no bundled template id needs that.)
          if (i + 1 < rest.length) decoded.push(rest[i + 1]);
          i += 2;
          continue;
        }
        if (c === quote) {
          // Single-quoted scalars treat `''` as a literal single
          // quote and continue scanning. Anything else is the
          // closing quote.
          if (quote === "'" && rest[i + 1] === "'") {
            decoded.push("'");
            i += 2;
            continue;
          }
          terminated = true;
          break;
        }
        decoded.push(c);
        i += 1;
      }
      if (!terminated) {
        // Unterminated quoted scalar — treat as no match rather
        // than guessing.
        continue;
      }
      return decoded.join("");
    }
    // Unquoted scalar — strip a trailing comment only when the `#`
    // is preceded by ASCII whitespace, per YAML 1.2 §6.6. A `#`
    // adjacent to a non-whitespace character is literal.
    const commentRe = /\s+#.*$/;
    const stripped = rest.replace(commentRe, "");
    return stripped.trimEnd();
  }
  return null;
}

/**
 * Lex `source` from `startIdx` as JS/TS code, tracking brace depth
 * across the five lexical productions that can contain `{` / `}`
 * without semantic meaning: line comments (`// …`), block comments
 * (`/* … *\/`), single-quoted strings, double-quoted strings, and
 * template literals (including their `${…}` interpolations).
 *
 * Real braces — i.e. `{` / `}` encountered in code state, NOT the
 * boundary braces of a template-literal interpolation — fire the
 * `onOpen` / `onClose` callbacks. `onClose` may return `true` to stop
 * the walk; this lets callers slice out an enclosing block as soon as
 * the matching closing brace is seen.
 *
 * Both `extractCategoriesBlock` and `extractCategoryEntries` share
 * this helper to avoid the two-copies-of-90-lines maintenance hazard:
 * every fix to the lexer (e.g. the `${…}` depth-decrement repair in
 * the previous round) only has to be made in one place, and any
 * future regression in one caller would by construction affect both.
 */
interface LexJsCallbacks {
  /** Fired when a real `{` is seen in code state. `depth` is the new depth (post-increment). */
  onOpen?: (pos: number, depth: number) => void;
  /** Fired when a real `}` is seen in code state (NOT a `${…}` closer). `depth` is the depth
   *  the closing brace is balancing against (i.e. the depth just *before* the decrement, equal
   *  to the depth at which the matching `{` opened). Return `true` to stop walking. */
  onClose?: (pos: number, depth: number) => boolean | void;
}

function lexJsBraces(
  source: string,
  startIdx: number,
  cb: LexJsCallbacks,
): void {
  let depth = 0;
  type LexState = "code" | "sl_comment" | "ml_comment" | "sq" | "dq" | "bt";
  let state: LexState = "code";
  // Stack of `${…}` interpolation depths so a `}` that closes an
  // interpolation doesn't fire onClose against the outer brace counter.
  const templateInterpStack: number[] = [];
  for (let i = startIdx; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (state === "code") {
      if (ch === "/" && next === "/") {
        state = "sl_comment";
        i += 1;
        continue;
      }
      if (ch === "/" && next === "*") {
        state = "ml_comment";
        i += 1;
        continue;
      }
      if (ch === "'") {
        state = "sq";
      } else if (ch === '"') {
        state = "dq";
      } else if (ch === "`") {
        state = "bt";
      } else if (ch === "{") {
        depth += 1;
        cb.onOpen?.(i, depth);
      } else if (ch === "}") {
        // Two cases:
        //   1. This `}` closes a `${…}` interpolation — the opener
        //      pushed onto templateInterpStack so that braces inside
        //      the interpolation could balance against the same
        //      counter (e.g. `${ x ? { a:1 } : { b:2 } }`). Undo the
        //      opener's depth bump and return to template-literal mode.
        //      Do NOT fire onClose: this is a lexical boundary, not a
        //      semantic brace.
        //   2. Otherwise, a real `}` in code. Decrement depth, fire
        //      onClose with the pre-decrement depth (= depth at which
        //      the matching `{` opened). If the callback signals stop,
        //      return immediately.
        if (templateInterpStack.length > 0) {
          const interpDepth = templateInterpStack[templateInterpStack.length - 1];
          if (depth === interpDepth) {
            templateInterpStack.pop();
            depth -= 1;
            state = "bt";
            continue;
          }
        }
        const closingDepth = depth;
        depth -= 1;
        if (cb.onClose?.(i, closingDepth)) return;
      }
    } else if (state === "sl_comment") {
      if (ch === "\n") {
        state = "code";
      }
    } else if (state === "ml_comment") {
      if (ch === "*" && next === "/") {
        state = "code";
        i += 1;
      }
    } else if (state === "sq" || state === "dq") {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if ((state === "sq" && ch === "'") || (state === "dq" && ch === '"')) {
        state = "code";
      }
    } else {
      // state === "bt" — inside a template literal.
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === "`") {
        state = "code";
      } else if (ch === "$" && next === "{") {
        // Step past the `${`, push the brace depth at which the
        // interpolation opened, and re-enter code mode. This brace is
        // counted (so braces inside the interpolation balance against
        // the same counter), but the open itself is a lexical
        // boundary — do NOT fire onOpen.
        i += 1;
        depth += 1;
        templateInterpStack.push(depth);
        state = "code";
      }
    }
  }
}

/**
 * Read `CreatePage.tsx` from disk and return the literal source of the
 * `const CATEGORIES … = { … }` object, sliced from the leading `const`
 * keyword to the matching closing brace (inclusive).
 *
 * We deliberately do a text-based extraction rather than importing
 * CATEGORIES directly, for two reasons:
 *
 *   1. CreatePage.tsx imports a number of React components that pull in
 *      Electron-only paths (e.g. the IPC types) — running it in vitest's
 *      jsdom environment is brittle in a way the rest of the test
 *      framework already accommodates, but pulling it in here for a
 *      static check would force every CreatePage refactor to also pass
 *      its full jsdom render harness.
 *
 *   2. The text-based check catches BOTH the registered id AND the case
 *      where someone deletes the CATEGORIES entry but leaves the YAML
 *      around (or vice versa).
 *
 * Finding the *matching* closing brace requires a real JS/TS lexer; a
 * naive brace counter would mis-balance the moment a `{` or `}`
 * appears inside a string literal, comment, or template literal
 * interpolation. The shared `lexJsBraces` helper covers those cases.
 *
 * Anchoring on the `=` token rather than the first `{` after `const
 * CATEGORIES` keeps the scan robust against future type-annotation
 * refactors. The current declaration is
 * `const CATEGORIES: Record<string, CategoryItem[]> = { … }` — no
 * braces in the type — but if a future maintainer inlined the entry
 * type (`Record<string, { id: string; … }[]>`), a `source.indexOf("{")`
 * anchor would start counting from the type's `{` and slice the wrong
 * range. Anchoring on the `=` puts us unambiguously at the value side.
 */
function extractCategoriesBlock(): string {
  const source = readFileSync(
    join(REPO_ROOT, "apps", "desktop", "renderer", "src", "pages", "CreatePage.tsx"),
    "utf8",
  );

  const start = source.indexOf("const CATEGORIES");
  if (start === -1) {
    throw new Error("CATEGORIES constant not found in CreatePage.tsx");
  }
  // Skip past the `=` so any `{` characters in the type annotation are
  // outside our scan window.
  const eqIdx = source.indexOf("=", start);
  if (eqIdx === -1) {
    throw new Error("CATEGORIES declaration is missing the `=` assignment token");
  }
  const openIdx = source.indexOf("{", eqIdx);
  if (openIdx === -1) {
    throw new Error("CATEGORIES declaration is missing the opening `{`");
  }

  let end = -1;
  lexJsBraces(source, openIdx, {
    onClose: (pos, depth) => {
      // depth === 1 means this `}` closes the outermost `{` of the
      // CATEGORIES object literal.
      if (depth === 1) {
        end = pos + 1;
        return true;
      }
    },
  });
  if (end === -1) {
    throw new Error("CATEGORIES constant did not close cleanly");
  }
  return source.slice(start, end);
}

/**
 * Parse the CATEGORIES block once and return the de-duplicated set of
 * template ids referenced. The id pattern is intentionally permissive
 * (`[A-Za-z0-9_-]+`): any string-shaped id is captured so that the
 * downstream cross-check ("every CATEGORIES id maps to a real bundled
 * template") raises a real, loud test failure when a contributor
 * sneaks in an id that violates the bundled-template `[a-z0-9][a-z0-9-]*`
 * convention. A stricter extraction regex here would *silently* drop
 * the non-conforming id and let the cross-check give a false pass.
 *
 * The leading `["']` is captured into group 1 and the trailing `\1`
 * backreference enforces that the closing quote matches the opening
 * one — a hand-edit like `id: "foo'` (open double, close single)
 * won't false-positive.
 */
function extractCategoryTemplateIds(): Set<string> {
  const block = extractCategoriesBlock();
  const ids = new Set<string>();
  const re = /\bid:\s*(["'])([A-Za-z0-9_-]+)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    ids.add(m[2]);
  }
  return ids;
}

/**
 * Parse the CATEGORIES block as a list of `(id, name)` tuples, one per
 * entry object literal. Used by the "no accidental copy-paste" check
 * below to surface intra-category duplication that the `Set<string>`
 * existence test would silently swallow.
 *
 * The same template id may legitimately appear multiple times in
 * CATEGORIES (e.g. `report-v1` shows up four times in the Analyze tab:
 * three workflow re-listings with distinct `name` fields plus the
 * regular tile). What is NOT legitimate is the same `(id, name)`
 * tuple appearing twice — that's always a copy-paste bug, since each
 * picker entry must carry a distinct human-facing label.
 *
 * Entry boundaries are found by tokenising the block with the same
 * lexer that finds the outer CATEGORIES close, then walking the
 * token stream looking for `{ … }` runs at depth = 2 (the object
 * literal for an individual picker entry, one level below the array
 * for its category).
 */
interface CategoryEntry {
  id: string;
  name: string;
  /** 1-indexed line number within the CATEGORIES block (for diagnostics). */
  line: number;
}

function extractCategoryEntries(): CategoryEntry[] {
  const block = extractCategoriesBlock();
  const out: CategoryEntry[] = [];

  // The CATEGORIES block begins with `{` (its outermost brace, opened
  // at depth = 1), each category-array `[` does not change brace
  // depth, and each entry-object `{` opens at depth = 2. We delegate
  // to the shared lexer and react only at depth = 2.
  const entryStarts: number[] = [];
  lexJsBraces(block, 0, {
    onOpen: (pos, depth) => {
      if (depth === 2) entryStarts.push(pos);
    },
    onClose: (pos, depth) => {
      if (depth !== 2 || entryStarts.length === 0) return;
      const startPos = entryStarts.pop()!;
      const slice = block.slice(startPos, pos + 1);
      const idMatch = /\bid:\s*(["'])([A-Za-z0-9_-]+)\1/.exec(slice);
      // `name` is a free-form string — allow C-style escapes inside
      // double-quoted values and treat the closing quote as the one
      // not preceded by `\`. The non-greedy `(?:\\.|[^\\])*?` inner
      // pattern stops at the first un-escaped quote that matches the
      // opener (captured as `\1`), so e.g. `"They\"re here"` matches
      // as a single string ending at the trailing `"`.
      const nameMatch = /\bname:\s*(["'])((?:\\.|[^\\])*?)\1/.exec(slice);
      if (idMatch && nameMatch) {
        const lineNumber = block.slice(0, startPos).split(/\r?\n/).length;
        out.push({ id: idMatch[2], name: nameMatch[2], line: lineNumber });
      }
    },
  });
  return out;
}

describe("phase verification — rendering services", () => {
  test("mermaidRenderer exports a render function and supporting types", () => {
    // The plan calls this out as "render function". Mermaid v11's
    // public surface uses `renderMermaid`, plus `initializeMermaid`
    // for one-time setup and `wrapSvgForEmbed` for export embedding.
    expect(typeof mermaidRenderer.renderMermaid).toBe("function");
    expect(typeof mermaidRenderer.initializeMermaid).toBe("function");
    expect(typeof mermaidRenderer.wrapSvgForEmbed).toBe("function");
    expect(typeof mermaidRenderer.detectDiagramType).toBe("function");
    expect(Array.isArray(mermaidRenderer.SUPPORTED_DIAGRAM_TYPES)).toBe(true);
    expect(mermaidRenderer.SUPPORTED_DIAGRAM_TYPES.length).toBeGreaterThan(0);
  });

  test("marpRenderer exports a render function and theme catalogue", () => {
    expect(typeof marpRenderer.renderMarp).toBe("function");
    expect(typeof marpRenderer.buildMarpFrontmatter).toBe("function");
    expect(typeof marpRenderer.extractSpeakerNotes).toBe("function");
    expect(typeof marpRenderer.splitSlides).toBe("function");
    expect(Array.isArray(marpRenderer.SUPPORTED_THEMES)).toBe(true);
    expect(marpRenderer.SUPPORTED_THEMES.length).toBeGreaterThanOrEqual(3);
  });

  test("iconResolver exports embedIcons + iconsToTextPlaceholder + resolution helpers", () => {
    expect(typeof iconResolver.embedIcons).toBe("function");
    expect(typeof iconResolver.iconsToTextPlaceholder).toBe("function");
    expect(typeof iconResolver.resolveIconSvg).toBe("function");
    expect(typeof iconResolver.parseIconSpec).toBe("function");
    expect(typeof iconResolver.listIcons).toBe("function");
    // embedIcons must actually do something when handed a known
    // Lucide / Phosphor icon spec — a stub returning the input
    // would still typecheck, so exercise the real path with a
    // tiny round-trip.
    const out = iconResolver.embedIcons("Status: {{icon:lucide:check}}");
    expect(out).toContain("<svg");
    expect(out).not.toContain("{{icon:lucide:check}}");
  });
});

describe("phase verification — editor barrel exports", () => {
  // The phase plan calls out all six editors explicitly. Removing or
  // renaming any of them would break the artifact-editor router, so
  // we lock down the surface here in addition to the unit tests.
  const expectedEditors = [
    "DocumentEditor",
    "SlideEditor",
    "SheetEditor",
    "BaseEditor",
    "InfographicEditor",
    "LandingPageEditor",
  ] as const;

  test.each(expectedEditors)("%s is exported from editors/index.ts", (name) => {
    // `editors` is the namespace import of editors/index.ts.
    const component = (editors as Record<string, unknown>)[name];
    expect(component, `editors/index.ts must export ${name}`).toBeDefined();
    // Each editor is a React component (function or memo/forwardRef
    // object); both shapes are truthy and either typeof function or
    // typeof object — assert at least that loose contract here.
    const t = typeof component;
    expect(["function", "object"]).toContain(t);
  });
});

describe("phase verification — bundled template registry", () => {
  const bundled = loadBundledTemplates();

  test("at least the original 36 bundled templates parse with a non-empty id", () => {
    // The Phase 5/6 build deliberately shipped a minimum of 36 templates
    // across the six artifact categories. Future growth (WS3 industry
    // / locale expansion) only ever adds, never removes — so this is a
    // floor, not a ceiling.
    expect(bundled.length).toBeGreaterThanOrEqual(36);
    for (const t of bundled) {
      expect(t.id, `${t.relPath} has empty id`).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    }
  });

  test("template ids are globally unique across all categories", () => {
    const seen = new Map<string, string>();
    for (const t of bundled) {
      const previous = seen.get(t.id);
      expect(
        previous,
        `Duplicate template id "${t.id}" in ${t.relPath} and ${previous}`,
      ).toBeUndefined();
      seen.set(t.id, t.relPath);
    }
  });

  test("every CATEGORIES id in CreatePage.tsx maps to a real bundled template", () => {
    const bundledIds = new Set(bundled.map((t) => t.id));
    const categoryIds = extractCategoryTemplateIds();
    expect(categoryIds.size).toBeGreaterThan(0);
    const missing: string[] = [];
    for (const id of categoryIds) {
      if (!bundledIds.has(id)) missing.push(id);
    }
    expect(
      missing,
      `CreatePage.tsx CATEGORIES references template ids with no matching YAML: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  test("CATEGORIES entries have unique (id, name) tuples", () => {
    // A given template id is allowed to appear in CATEGORIES multiple
    // times — e.g. `report-v1` is intentionally re-listed in the
    // Analyze tab as three workflow shortcuts plus the regular tile,
    // each with a distinct `name` describing the user-facing affordance.
    // What is NOT allowed is the same (id, name) tuple repeating: that
    // would always be a copy-paste accident, since two picker entries
    // with identical labels would be indistinguishable to the user.
    //
    // The Set<string>-based "every id maps to bundled" test above
    // silently de-duplicates such pairs, so we run a dedicated check
    // here that surfaces them.
    const entries = extractCategoryEntries();
    expect(
      entries.length,
      "expected extractCategoryEntries to find at least one CATEGORIES entry — has the CreatePage.tsx layout changed?",
    ).toBeGreaterThan(0);
    const seen = new Map<string, number>();
    const duplicates: string[] = [];
    for (const entry of entries) {
      const key = `${entry.id}|${entry.name}`;
      const previousLine = seen.get(key);
      if (previousLine !== undefined) {
        duplicates.push(
          `(id="${entry.id}", name="${entry.name}") at block lines ${previousLine} and ${entry.line}`,
        );
        continue;
      }
      seen.set(key, entry.line);
    }
    expect(
      duplicates,
      `CreatePage.tsx CATEGORIES contains duplicate (id, name) tuples — almost certainly copy-paste errors:\n  ${duplicates.join("\n  ")}`,
    ).toEqual([]);
  });

  test("every templates/ subdirectory is a classified category", () => {
    // Dynamically enumerate the live `templates/` tree at test time and
    // assert that every subdirectory is explicitly classified as either
    // a template category (`TEMPLATE_CATEGORIES`) or a deliberate
    // non-category (`NON_TEMPLATE_DIRS`).
    //
    // This closes the failure mode Devin Review round-6 flagged: if a
    // contributor adds a new category directory (say `templates/forms/`)
    // without updating `TEMPLATE_CATEGORIES`, the `loadBundledTemplates`
    // walker above silently skips it. Walking the directory at runtime
    // here forces the new category to be classified before the suite
    // can pass.
    //
    // The Rust companion test
    // (`crates/tessera_templates/tests/phase_smoke_templates.rs::
    // every_templates_subdirectory_is_classified`) enforces the same
    // invariant against `RUST_TEMPLATE_DIRS` + `RENDERER_ONLY_TEMPLATE_DIRS`
    // + `NON_TEMPLATE_DIRS`, so all three hand-maintained lists (Rust × 2
    // + TS × 1) are now gated by runtime discovery.
    const discovered = readdirSync(TEMPLATES_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();

    const classified = new Set<string>([
      ...TEMPLATE_CATEGORIES,
      ...NON_TEMPLATE_DIRS,
    ]);

    const unclassified = discovered.filter((d) => !classified.has(d));
    expect(
      unclassified,
      `Unclassified templates/ subdirectories found: ${unclassified.join(", ")}.\n` +
        `Add each to TEMPLATE_CATEGORIES (if it is a template artifact type)\n` +
        `or NON_TEMPLATE_DIRS (if it is not a template category at all). The Rust\n` +
        `smoke suite's RUST_TEMPLATE_DIRS / RENDERER_ONLY_TEMPLATE_DIRS lists must\n` +
        `also be updated.`,
    ).toEqual([]);

    // Symmetry check: every name in the two lists must correspond to a
    // real directory. A stale entry (e.g. a category that was removed)
    // would otherwise sit forever in the constants pretending to be
    // covered.
    const discoveredSet = new Set(discovered);
    const stale = [...TEMPLATE_CATEGORIES, ...NON_TEMPLATE_DIRS].filter(
      (name) => !discoveredSet.has(name),
    );
    expect(
      stale,
      `Classified directory names that don't exist under templates/: ${stale.join(", ")}.\n` +
        `Remove them from the constants — the smoke suite should not claim\n` +
        `coverage of a directory that isn't on disk.`,
    ).toEqual([]);
  });
});
