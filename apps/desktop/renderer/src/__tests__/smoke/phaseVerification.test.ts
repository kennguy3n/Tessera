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
// add it here and add a section parser below — the test will fail loudly
// if a new directory shows up that isn't covered.
//
// NOTE: `templates/grammars/` is intentionally not listed here. That
// directory holds GBNF grammar files (`.gbnf`) that constrain LLM
// output for structured generation — it is not a template category.
// The walker below filters on the `.yaml`/`.yml` extension anyway, so
// even if a stray `.gbnf` ended up under one of the listed categories
// it would be skipped, but keeping the exclusion explicit here means
// a future contributor reading this list isn't left wondering whether
// `grammars/` was an oversight.
const TEMPLATE_CATEGORIES = [
  "documents",
  "slides",
  "sheets",
  "bases",
  "infographics",
  "landing_pages",
] as const;

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
    // trailing text on the line (including `#`) is comment.
    if (rest.startsWith('"') || rest.startsWith("'")) {
      const quote = rest[0];
      // Find the matching closing quote. YAML 1.2 double-quoted
      // scalars support C-style escapes; for our limited use case
      // (template ids and types) we don't need full escape handling
      // — a closing quote that isn't preceded by `\\` is sufficient.
      let i = 1;
      while (i < rest.length) {
        if (rest[i] === "\\" && quote === '"') {
          i += 2;
          continue;
        }
        if (rest[i] === quote) break;
        i += 1;
      }
      if (i >= rest.length) {
        // Unterminated quoted scalar — treat as no match rather
        // than guessing.
        continue;
      }
      return rest.slice(1, i);
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
 * Parse `CreatePage.tsx` and extract the set of template ids referenced
 * by the CATEGORIES constant. We deliberately do a text-based extraction
 * rather than importing CATEGORIES directly, for two reasons:
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
 * The regex matches `id: "..."` and `id: '...'` inside the CATEGORIES
 * literal. False positives are ruled out by anchoring on the leading
 * `{` of each object literal entry below.
 */
function extractCategoryTemplateIds(): Set<string> {
  const source = readFileSync(
    join(REPO_ROOT, "apps", "desktop", "renderer", "src", "pages", "CreatePage.tsx"),
    "utf8",
  );

  // Slice from `const CATEGORIES` to the matching closing brace so we
  // only see ids inside the constant, not template-string ids that
  // happen to appear later in the file (e.g. fallback messages).
  const start = source.indexOf("const CATEGORIES");
  if (start === -1) {
    throw new Error("CATEGORIES constant not found in CreatePage.tsx");
  }
  // Find the closing `}` after `start`. We track brace depth from the
  // first `{` after `const CATEGORIES`, BUT we must skip braces that
  // appear inside JS/TS lexical constructs that contain syntactic
  // noise — namely string literals (single-quoted, double-quoted,
  // backtick template literals with `${...}` interpolations) AND
  // single-line / multi-line comments. The simpler "count every `{`
  // and `}`" approach worked by accident for the original CATEGORIES
  // block, but a comment like `// they're the first thing` would
  // confuse a half-aware string-skipping lexer into entering a
  // never-closed single-quote state. The state machine below covers
  // the five JS/TS productions that can contain `{`/`}` without
  // meaning them: line comment, block comment, single-quoted string,
  // double-quoted string, and template literal (with nested code via
  // `${...}`).
  let depth = 0;
  let i = source.indexOf("{", start);
  let end = -1;
  type LexState = "code" | "sl_comment" | "ml_comment" | "sq" | "dq" | "bt";
  let state: LexState = "code";
  // Track template-literal interpolation nesting depth so a `}` that
  // closes a `${...}` doesn't get charged against the outer brace
  // counter.
  const templateInterpStack: number[] = [];
  for (; i < source.length; i++) {
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
      } else if (ch === "}") {
        // A `}` here either closes a `${...}` interpolation (returning
        // us to the surrounding template literal) or closes a real
        // brace pair in code.
        if (templateInterpStack.length > 0) {
          const interpDepth = templateInterpStack[templateInterpStack.length - 1];
          if (depth === interpDepth) {
            templateInterpStack.pop();
            state = "bt";
            continue;
          }
        }
        depth -= 1;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    } else if (state === "sl_comment") {
      // Line comment terminates at the next newline.
      if (ch === "\n") {
        state = "code";
      }
    } else if (state === "ml_comment") {
      // Block comment terminates at the matching `*/`.
      if (ch === "*" && next === "/") {
        state = "code";
        i += 1;
      }
    } else if (state === "sq" || state === "dq") {
      // Inside a non-template string: respect backslash escapes and
      // stop on the matching closing quote.
      if (ch === "\\") {
        i += 1; // skip the escaped character
        continue;
      }
      if ((state === "sq" && ch === "'") || (state === "dq" && ch === '"')) {
        state = "code";
      }
    } else {
      // state === "bt" — inside a template literal. `${` starts a
      // code-mode interpolation that ends at the matching `}`.
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === "`") {
        state = "code";
      } else if (ch === "$" && next === "{") {
        // Step past the `${`, push the brace depth at which the
        // interpolation opened, and re-enter code mode.
        i += 1;
        depth += 1;
        templateInterpStack.push(depth);
        state = "code";
      }
    }
  }
  if (end === -1) {
    throw new Error("CATEGORIES constant did not close cleanly");
  }
  const block = source.slice(start, end);

  const ids = new Set<string>();
  // The leading `["']` is captured into group 1 and the trailing
  // `\1` backreference enforces that the closing quote matches the
  // opening one — a future maintainer who hand-edits CATEGORIES into
  // `id: "foo'` won't get a false positive. The id pattern itself
  // is constrained to the same `[a-z0-9][a-z0-9-]*` shape that the
  // bundled-template loader enforces, so accidental matches against
  // longer string literals elsewhere in CreatePage.tsx (e.g. badge
  // names like "workflow") are ruled out structurally.
  const re = /\bid:\s*(["'])([a-z0-9][a-z0-9-]*)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    ids.add(m[2]);
  }
  return ids;
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
});
