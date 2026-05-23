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
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { describe, expect, test } from "vitest";

import * as mermaidRenderer from "../../services/mermaidRenderer";
import * as marpRenderer from "../../services/marpRenderer";
import * as iconResolver from "../../services/iconResolver";
import * as editors from "../../editors";

// Repository root — located by walking up from this test file looking
// for the workspace-root sentinel pair (a `Cargo.toml` containing a
// top-level `[workspace]` table AND a `templates/` directory). The
// previous implementation hardcoded a six-level `..` path:
//
//   resolve(__dirname, "..", "..", "..", "..", "..", "..")
//
// which Devin Review round-11 correctly flagged as fragile against
// future repository layout changes — promoting the smoke suite to a
// top-level `tests/` directory, moving it deeper into a fixture
// folder, or any other relocation would silently slice the wrong
// `REPO_ROOT` and either fail mysteriously or, worse, succeed against
// the wrong directory tree. The upward-walk pattern is the long-term
// correct fix: it tolerates any future file move so long as the test
// stays somewhere under the workspace root.
//
// We require BOTH conditions because:
//   • `Cargo.toml` alone matches every per-crate manifest under
//     `crates/`, so we need the `[workspace]` marker to disambiguate.
//   • `[workspace]` parsing without `templates/` would still match a
//     stripped-down workspace; requiring `templates/` pins us to the
//     Tessera repo specifically.
function findRepoRoot(startDir: string): string {
  // The walk is bounded: each iteration steps one directory closer to
  // the filesystem root, and POSIX guarantees `dirname` is idempotent
  // at `/` (Windows: at the drive root). The explicit `parent === dir`
  // termination check guarantees we never loop. We use `for (;;)`
  // rather than `while (true)` to keep ESLint's `no-constant-condition`
  // rule happy — both compile to identical bytecode.
  let dir = startDir;
  for (;;) {
    const cargoToml = join(dir, "Cargo.toml");
    const templatesDir = join(dir, "templates");
    if (existsSync(cargoToml) && existsSync(templatesDir)) {
      try {
        const body = readFileSync(cargoToml, "utf8");
        // `^\[workspace\]` (multiline) matches the table header even
        // when it's preceded by other tables earlier in the file.
        // Per-crate Cargo.toml files never carry `[workspace]`, so
        // this cleanly distinguishes the root manifest.
        if (/^\[workspace\]/m.test(body)) {
          return dir;
        }
      } catch {
        // Unreadable Cargo.toml — keep walking. The throw at the
        // filesystem-root boundary below is the eventual stop.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `phaseVerification.test.ts could not locate the Tessera workspace ` +
          `root by walking up from ${startDir}: no ancestor directory ` +
          `contains both a Cargo.toml with [workspace] AND a templates/ ` +
          `directory. Either the test file was moved outside the repo, ` +
          `or the workspace layout changed in a way the smoke suite ` +
          `needs to be updated to accommodate.`,
      );
    }
    dir = parent;
  }
}

const REPO_ROOT = findRepoRoot(__dirname);
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
    // Unquoted scalar.
    //
    // Two YAML 1.2 §6.6 sub-cases need separate handling:
    //
    //   (a) `<key>:<ws>#…` — the `#` is at the start of the value
    //       region (no inter-token whitespace before it). Per YAML
    //       1.2 §6.6, a `#` that is preceded by ASCII whitespace
    //       (which we already stripped above with the
    //       `replace(/^[\t ]+/, "")`) begins a comment, so the entire
    //       value region is a comment and the scalar's value is YAML
    //       null. We return null rather than the literal comment
    //       string so callers can distinguish "key absent" from
    //       "key present with null value".
    //
    //   (b) `<key>:<ws><non-#…> [<ws>#…]` — a normal unquoted scalar,
    //       with an optional trailing comment. The comment-strip
    //       regex `/\s+#.*$/` peels off only the genuine trailing
    //       comment because YAML 1.2 §6.6 requires the `#` to be
    //       preceded by whitespace; a `#` adjacent to non-whitespace
    //       (e.g. `id: foo#bar`) stays literal.
    //
    // Devin Review round-10 flagged the round-9 implementation as
    // returning `"# comment"` literally for case (a), which (while
    // not exercised by any real bundled template — every shipped
    // template has a non-empty id) would confuse any future caller.
    // The explicit branch here is the long-term-correct fix.
    if (rest.startsWith("#")) return null;
    const commentRe = /\s+#.*$/;
    const stripped = rest.replace(commentRe, "").trimEnd();
    // A YAML mapping entry with no value (`id:` followed by nothing
    // or only whitespace) is YAML null. Mirror case (a)'s null
    // return to keep the contract uniform.
    if (stripped.length === 0) return null;
    return stripped;
  }
  return null;
}

/**
 * Lex `source` from `startIdx` as JS/TS code and emit token events.
 *
 * This is the single source of truth for JS/TS lexical state in the
 * smoke suite. Earlier rounds shipped two separate state machines —
 * one in `lexJsBraces` (brace-tracking only) and one inside
 * `extractObjectProperties` (brace + identifier + colon + string
 * tracking) — and Devin Review correctly flagged the duplication as a
 * maintenance hazard: any fix to one lexer (e.g. the `${…}`
 * depth-decrement repair in round 6) would have to be applied to both,
 * and a regression in only one would silently diverge them. The unified
 * lexer below covers BOTH callers' needs through optional callbacks.
 *
 * Five lexical productions can hide `{` / `}` / identifier-shaped
 * substrings from semantic interpretation:
 *
 *   1. line comments (`// …`)
 *   2. block comments (`/* … *\/`)
 *   3. single-quoted strings
 *   4. double-quoted strings
 *   5. template literals — including their `${…}` interpolations,
 *      which re-enter code state and may themselves contain strings,
 *      nested braces, further template literals, etc.
 *
 * Inside those productions, no callbacks fire. In code state, the
 * lexer emits at most one callback per logical token:
 *
 *   - `onOpen`  on every `{` that is not the lexical boundary of a
 *     `${…}` template-literal interpolation. `depth` is the
 *     post-increment value (so the outermost `{` of a fresh lex pass
 *     fires onOpen with depth = 1).
 *   - `onClose` on every `}` that is not the closing brace of a
 *     `${…}` interpolation. `depth` is the pre-decrement value (=
 *     the depth at which the matching `{` opened).
 *   - `onIdentifier` on every contiguous run of identifier characters
 *     (`[A-Za-z_$][A-Za-z0-9_$]*`) seen in code state.
 *   - `onColon` on every `:` punctuator in code state.
 *   - `onStringLiteral` on every single- or double-quoted string
 *     literal, with `decoded` already containing the JS-escape-decoded
 *     value (each `\X` is passed through as `X`; this matches the
 *     behaviour ECMA-262 requires for the only escape sequences
 *     CATEGORIES values ever use — `\'` and `\"`).
 *
 * Any callback may return `true` to halt the walk; this lets callers
 * stop as soon as they have seen the event they care about.
 *
 * The lexer does NOT emit events for: whitespace, numeric literals,
 * regex literals, JSX, decorators, BigInt suffixes, hash-private
 * fields, or any other punctuator besides `:`. Those are outside the
 * scope this suite needs — extending here is the place to add them,
 * NOT in a parallel state machine.
 */
interface LexJsCallbacks {
  /** Fired when a real `{` is seen in code state. `depth` is the new depth
   *  (post-increment). Return `true` to stop walking. */
  onOpen?: (pos: number, depth: number) => boolean | void;
  /** Fired when a real `}` is seen in code state (NOT a `${…}` closer).
   *  `depth` is the depth the closing brace is balancing against (i.e. the
   *  depth just *before* the decrement, equal to the depth at which the
   *  matching `{` opened). Return `true` to stop walking. */
  onClose?: (pos: number, depth: number) => boolean | void;
  /** Fired when an identifier-shaped token is seen in code state. `pos` is
   *  the position of the first character; `endPos` is the position just
   *  after the last character (so `source.slice(pos, endPos) === name`).
   *  `depth` is the current brace depth. Return `true` to stop walking. */
  onIdentifier?: (
    pos: number,
    name: string,
    endPos: number,
    depth: number,
  ) => boolean | void;
  /** Fired when a `:` punctuator is seen in code state. `depth` is the
   *  current brace depth. Return `true` to stop walking. */
  onColon?: (pos: number, depth: number) => boolean | void;
  /** Fired when a string literal is seen in code state. `pos` points at the
   *  opening quote; `endPos` is the position just after the closing quote.
   *  `decoded` honours JS backslash escapes (each `\X` passes through as
   *  `X`); `quote` is the literal delimiter used. `depth` is the current
   *  brace depth. Return `true` to stop walking. */
  onStringLiteral?: (
    pos: number,
    decoded: string,
    quote: "'" | '"',
    endPos: number,
    depth: number,
  ) => boolean | void;
}

function lexJs(
  source: string,
  startIdx: number,
  cb: LexJsCallbacks,
): void {
  let depth = 0;
  type LexState = "code" | "sl_comment" | "ml_comment" | "bt";
  let state: LexState = "code";
  // Stack of `${…}` interpolation depths so a `}` that closes an
  // interpolation doesn't fire onClose against the outer brace counter.
  const templateInterpStack: number[] = [];
  let i = startIdx;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (state === "code") {
      if (ch === "/" && next === "/") {
        state = "sl_comment";
        i += 2;
        continue;
      }
      if (ch === "/" && next === "*") {
        state = "ml_comment";
        i += 2;
        continue;
      }
      if (ch === "`") {
        state = "bt";
        i += 1;
        continue;
      }
      if (ch === '"' || ch === "'") {
        // Consume the string literal inline. We emit a single
        // onStringLiteral event with the decoded payload — strings are
        // atomic tokens, never something the outer walker re-enters
        // mid-flight, so the previous `sq` / `dq` states are gone.
        //
        // Escape decoding is JS / TypeScript semantics: a backslash
        // protects the next character (so `\'`, `\"`, `\n`, `\\` all
        // pass through as the literal next character). We do not run
        // ECMA-262 §12.8.4 escape-sequence substitution because the
        // only escapes CATEGORIES values ever contain are `\'` /
        // `\"`, both of which the pass-through gives correctly. A
        // future caller that needs `\n` → newline can extend the
        // decode here.
        const quote = ch as "'" | '"';
        const startPos = i;
        let j = i + 1;
        const decoded: string[] = [];
        let terminated = false;
        while (j < source.length) {
          const c = source[j];
          if (c === "\\") {
            if (j + 1 < source.length) decoded.push(source[j + 1]);
            j += 2;
            continue;
          }
          if (c === quote) {
            terminated = true;
            break;
          }
          decoded.push(c);
          j += 1;
        }
        if (!terminated) {
          // Unterminated string — abort lexing rather than guessing.
          return;
        }
        const endPos = j + 1;
        if (
          cb.onStringLiteral?.(
            startPos,
            decoded.join(""),
            quote,
            endPos,
            depth,
          )
        ) {
          return;
        }
        i = endPos;
        continue;
      }
      if (ch === "{") {
        depth += 1;
        if (cb.onOpen?.(i, depth)) return;
        i += 1;
        continue;
      }
      if (ch === "}") {
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
            i += 1;
            continue;
          }
        }
        const closingDepth = depth;
        depth -= 1;
        if (cb.onClose?.(i, closingDepth)) return;
        i += 1;
        continue;
      }
      if (ch === ":") {
        if (cb.onColon?.(i, depth)) return;
        i += 1;
        continue;
      }
      if (/[A-Za-z_$]/.test(ch)) {
        // Identifier run.
        const idStart = i;
        let j = i + 1;
        while (j < source.length && /[A-Za-z0-9_$]/.test(source[j])) j++;
        const name = source.slice(idStart, j);
        if (cb.onIdentifier?.(idStart, name, j, depth)) return;
        i = j;
        continue;
      }
      i += 1;
    } else if (state === "sl_comment") {
      if (ch === "\n") state = "code";
      i += 1;
    } else if (state === "ml_comment") {
      if (ch === "*" && next === "/") {
        state = "code";
        i += 2;
        continue;
      }
      i += 1;
    } else {
      // state === "bt" — inside a template literal.
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "`") {
        state = "code";
        i += 1;
        continue;
      }
      if (ch === "$" && next === "{") {
        // Step past the `${`, push the brace depth at which the
        // interpolation opened, and re-enter code mode. This brace is
        // counted (so braces inside the interpolation balance against
        // the same counter), but the open itself is a lexical
        // boundary — do NOT fire onOpen.
        depth += 1;
        templateInterpStack.push(depth);
        state = "code";
        i += 2;
        continue;
      }
      i += 1;
    }
  }
}

/**
 * Read `CreatePage.tsx` from disk and return the literal source of the
 * CATEGORIES object literal, sliced from the opening `{` (inclusive)
 * to the matching closing `}` (inclusive).
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
 * interpolation. The shared `lexJs` helper covers those cases.
 *
 * The function returns ONLY the object literal — i.e. the slice begins
 * at the value side `{` rather than at the `const CATEGORIES` keyword.
 * This was Devin Review round-9 finding #0001: returning the larger
 * slice meant downstream lexers had to lex past the (currently
 * empty-of-braces, but theoretically arbitrary) type annotation
 * `Record<string, CategoryItem[]>`. Anchoring the returned slice on
 * the object literal removes that latent risk and matches the
 * function's stated purpose. Anchoring on the `=` BEFORE searching for
 * `{` keeps the search robust against a future inlined-entry-type
 * refactor (`Record<string, { id: string; … }[]>`); we never look at
 * the type annotation's contents.
 */
function extractCategoriesBlock(): string {
  const source = readFileSync(
    join(REPO_ROOT, "apps", "desktop", "renderer", "src", "pages", "CreatePage.tsx"),
    "utf8",
  );

  // Anchored, multi-line regex: `const CATEGORIES` MUST appear at the
  // start of a line, and the next non-whitespace token MUST be `:` (a
  // TS type annotation) or `=` (a direct assignment). The previous
  // implementation used `source.indexOf("const CATEGORIES")`, which
  // Devin Review round-10 correctly flagged as fragile: it would
  // false-match against a TS declaration like
  // `const CATEGORIES_METADATA = ...` (same prefix, different
  // identifier), or against a comment line like
  // `// const CATEGORIES — legacy registry`. Today CreatePage.tsx
  // has exactly one match, but the smoke suite is supposed to be
  // defensive against future maintenance, not optimistic about it.
  //
  // The `m` flag makes `^` match start-of-line (so indented
  // occurrences inside comments / functions don't qualify), the `\b`
  // after `CATEGORIES` enforces a word boundary (so
  // `CATEGORIES_METADATA` is excluded), and `[:=]` requires the next
  // non-whitespace token to be a type-annotation or assignment
  // operator. We capture nothing — only the match position is used.
  const declRe = /^const CATEGORIES\b[ \t]*[:=]/m;
  const declMatch = declRe.exec(source);
  if (declMatch === null) {
    throw new Error(
      "CATEGORIES constant not found in CreatePage.tsx — " +
        "expected a top-level `const CATEGORIES ...:` or `... =` declaration",
    );
  }
  const decl = declMatch.index;
  // Skip past the `=` so any `{` characters in the type annotation are
  // outside our scan window.
  const eqIdx = source.indexOf("=", decl);
  if (eqIdx === -1) {
    throw new Error("CATEGORIES declaration is missing the `=` assignment token");
  }
  const openIdx = source.indexOf("{", eqIdx);
  if (openIdx === -1) {
    throw new Error("CATEGORIES declaration is missing the opening `{`");
  }

  let end = -1;
  lexJs(source, openIdx, {
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
  return source.slice(openIdx, end);
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

/**
 * Walk a `{...}` object-literal slice and extract the literal string
 * values of its TOP-LEVEL (non-nested) properties whose keys appear in
 * `wanted`.
 *
 * "Top-level" means a property whose `key:` appears at brace depth 1
 * relative to the opening `{` of `slice`. Properties of nested object
 * literals don't qualify, and identifier-like substrings inside a
 * value's string literal won't be mistaken for a property key — the
 * JS/TS lexical state machine driving the walk ensures that.
 *
 * Devin Review round-7 flagged the previous regex-based approach as
 * fragile: a regex like `/\bname:\s*(["'])(...)\1/.exec(slice)` would
 * false-match if an earlier property's string value contained the
 * literal substring `name: "..."`. Round-9 then flagged the
 * lexer-based replacement for duplicating the brace-tracking state
 * machine from `lexJsBraces`. The current incarnation is the proper
 * long-term fix to BOTH: this helper is now a thin observer on top of
 * the shared `lexJs` lexer, so any future fix to escape decoding /
 * template-literal handling / brace tracking lands in one place and
 * automatically applies to every caller.
 *
 * Only single- and double-quoted string values are decoded. Properties
 * whose values are bare identifiers, numbers, arrays, nested objects,
 * or template literals return `null` (the entry simply has no recorded
 * value for that key). For our use case the picker entries' `id` and
 * `name` are always quoted strings, so the limited support is
 * sufficient — and `lexJs`'s escape decoding correctly handles
 * `'L\'Étranger'` / `"She said \"hi\""` / etc.
 *
 * State machine on top of the lex stream:
 *
 *   - An identifier event at depth 1 records the candidate key. A
 *     later identifier at the same depth replaces it (e.g. a
 *     shorthand-property declaration `foo,` with no colon following).
 *   - A string event at depth 1 ALSO records a candidate key, when
 *     not already awaiting a value. This supports object literals
 *     with QUOTED property keys (`{ "id": "v" }` or `{ 'id': 'v' }`)
 *     in addition to the unquoted-identifier form (`{ id: "v" }`).
 *     CreatePage.tsx today uses unquoted keys exclusively, but a
 *     future refactor (or copy-paste from JSON) could introduce
 *     quoted keys; Devin Review round-10 flagged the previous
 *     identifier-only behaviour as a silent gap, and the long-term
 *     fix is to accept both. The string-event handler distinguishes
 *     "this string is a candidate KEY" (not awaiting after a colon)
 *     from "this string is the VALUE for the pending key" (awaiting)
 *     via the `awaitingValueAfterColon` flag.
 *   - A colon event at the candidate's depth marks us as awaiting a
 *     string value.
 *   - A string event at the candidate's depth, while awaiting, is the
 *     value. Record it (first-occurrence-wins so a re-declared key
 *     keeps the first value — re-declaration is a lint error in
 *     CreatePage.tsx anyway), then clear pending state.
 *   - Any open / close brace clears pending state — the value was a
 *     nested object, not a string.
 */
function extractObjectProperties(
  slice: string,
  wanted: ReadonlyArray<string>,
): Record<string, string | null> {
  const want = new Set(wanted);
  const result: Record<string, string | null> = {};
  for (const w of wanted) result[w] = null;

  let pendingKey: string | null = null;
  let pendingKeyDepth = -1;
  let awaitingValueAfterColon = false;

  lexJs(slice, 0, {
    onIdentifier: (_pos, name, _endPos, depth) => {
      if (depth !== 1) {
        // Nested-object property keys are explicitly out of scope. We
        // also drop any pending key — a nested object value should not
        // pick up an inner property as its own.
        pendingKey = null;
        awaitingValueAfterColon = false;
        return;
      }
      // New identifier at top depth — replaces any pending key. If we
      // were awaiting a string value, the actual value turned out to
      // be a bare identifier (e.g. `true` / `null` / a referenced
      // variable). That's not a string we can decode, so we abandon
      // the previous pair and treat this identifier as the next key.
      pendingKey = name;
      pendingKeyDepth = depth;
      awaitingValueAfterColon = false;
    },
    onColon: (_pos, depth) => {
      if (pendingKey !== null && depth === pendingKeyDepth) {
        awaitingValueAfterColon = true;
      }
    },
    onStringLiteral: (_pos, decoded, _quote, _endPos, depth) => {
      if (depth !== 1) {
        // Nested-string values (e.g. inside an array or nested object)
        // can't be top-level properties of THIS object. Drop pending
        // state so they don't get accidentally captured as a value.
        pendingKey = null;
        awaitingValueAfterColon = false;
        return;
      }
      if (
        awaitingValueAfterColon &&
        pendingKey !== null &&
        depth === pendingKeyDepth
      ) {
        if (want.has(pendingKey) && result[pendingKey] === null) {
          // First occurrence wins so that, e.g., a property re-declared
          // illegally (`{ id: "a", id: "b" }`) records the first value.
          result[pendingKey] = decoded;
        }
        pendingKey = null;
        awaitingValueAfterColon = false;
        return;
      }
      // Not awaiting a value — this string is a candidate KEY for the
      // `"key": value` quoted-key form. Replace any previous pending
      // key (mirrors the identifier-replacement semantics above).
      pendingKey = decoded;
      pendingKeyDepth = depth;
      awaitingValueAfterColon = false;
    },
    onOpen: () => {
      // Opening a nested object resets pending state — the previous
      // identifier+colon was followed by `{`, not a string, so the
      // value is a nested object (not a string we can decode).
      pendingKey = null;
      awaitingValueAfterColon = false;
    },
    onClose: () => {
      // Same rationale for `}`: we crossed an object boundary, drop
      // any half-built pending state.
      pendingKey = null;
      awaitingValueAfterColon = false;
    },
  });
  return result;
}

function extractCategoryEntries(): CategoryEntry[] {
  const block = extractCategoriesBlock();
  const out: CategoryEntry[] = [];

  // The CATEGORIES block now begins with the value-side `{` directly
  // (Devin Review round-9 finding #0001 — extractCategoriesBlock no
  // longer includes the `const CATEGORIES: …Type… =` prefix). So the
  // outermost CATEGORIES brace opens at depth = 1, the category-array
  // `[` does not change brace depth, and each entry-object `{` opens
  // at depth = 2.
  //
  // Inside each entry slice, `extractObjectProperties` consumes the
  // SAME `lexJs` token stream, so an entry value like `description:
  // "see id: foo for details"` cannot pollute the `id` / `name`
  // capture — both helpers honour identical lexical state, by
  // construction (round-9 finding #0003).
  const entryStarts: number[] = [];
  lexJs(block, 0, {
    onOpen: (pos, depth) => {
      if (depth === 2) entryStarts.push(pos);
    },
    onClose: (pos, depth) => {
      if (depth !== 2 || entryStarts.length === 0) return;
      const startPos = entryStarts.pop()!;
      const slice = block.slice(startPos, pos + 1);
      const props = extractObjectProperties(slice, ["id", "name"]);
      const id = props.id;
      const name = props.name;
      if (id && name) {
        const lineNumber = block.slice(0, startPos).split(/\r?\n/).length;
        out.push({ id, name, line: lineNumber });
      }
    },
  });
  return out;
}

/**
 * The de-duplicated set of template ids referenced from CreatePage.tsx's
 * CATEGORIES constant. Derived directly from `extractCategoryEntries`
 * so both checks share a single extraction path — Devin Review
 * round-9 finding #0002 correctly flagged that an earlier regex-based
 * implementation could false-match `id:` inside string values or
 * comments. Folding it onto the lexer-based entry walker means the
 * two helpers can never disagree about what a "CATEGORIES id" is.
 */
function extractCategoryTemplateIds(): Set<string> {
  return new Set(extractCategoryEntries().map((e) => e.id));
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

describe("phase verification — internal helper invariants", () => {
  // These tests pin down the behaviour of the helpers above so future
  // refactors can't silently regress them. Devin Review round-7 flagged
  // the previous regex-based extractor as fragile against
  // identifier-like substrings inside string values; the new
  // `extractObjectProperties` lexer is the correct fix, and the cases
  // below lock that in.

  test("extractObjectProperties returns null for missing keys", () => {
    const props = extractObjectProperties(`{ id: "foo" }`, ["id", "name"]);
    expect(props.id).toBe("foo");
    expect(props.name).toBeNull();
  });

  test("extractObjectProperties is not fooled by 'name:' substring in another value", () => {
    // Before round-7, the regex /\bname:\s*(["'])(?:\\.|[^\\])*?\1/.exec(slice)
    // applied to the entry slice as a whole would match the SUBSTRING
    // `name: 'imposter'` inside the description value, since the regex
    // doesn't know it's inside a string. The walker honours JS lexical
    // state, so the only `name:` that counts is the one at depth 1 in
    // code state — here, the trailing `name: "real"` property.
    const slice = `{
      id: "real-id",
      description: "this entry has a description that mentions name: 'imposter' inline",
      name: "real",
    }`;
    const props = extractObjectProperties(slice, ["id", "name"]);
    expect(props.id).toBe("real-id");
    expect(props.name).toBe("real");
  });

  test("extractObjectProperties ignores nested-object property keys", () => {
    // A property whose value is a nested object literal can itself
    // declare a `name:` inside that nested object. The outer walker
    // tracks depth, so depth > 1 keys are ignored.
    const slice = `{
      id: "outer",
      meta: { name: "inner-imposter", description: "nested" },
      name: "outer-real",
    }`;
    const props = extractObjectProperties(slice, ["id", "name"]);
    expect(props.id).toBe("outer");
    expect(props.name).toBe("outer-real");
  });

  test("extractObjectProperties handles single-quoted \\' escapes (JS semantics)", () => {
    // JS string literal semantics — `\'` inside a single-quoted string
    // is the escape for a literal `'`. Tessera doesn't currently use
    // this pattern in CATEGORIES (today every name uses double quotes),
    // but a future localisation that adds e.g. a French entry name
    // would write it as either `"L'Étranger"` (double-quoted, no
    // escape needed) or `'L\'Étranger'` (single-quoted with escape).
    // The walker has to decode the second form correctly.
    //
    // Devin Review round-8 flagged that an earlier version of this
    // helper used the YAML `''` convention by accident — adjacent
    // single quotes are NOT a JS escape, they are two separate string
    // literals, which is a syntax error inside an object literal.
    // The companion YAML scalar extractor (`extractTopLevelScalar`)
    // legitimately uses `''` because it parses YAML, but this helper
    // parses JavaScript.
    const slice = `{ id: "a", name: 'L\\'Étranger' }`;
    const props = extractObjectProperties(slice, ["id", "name"]);
    expect(props.name).toBe("L'Étranger");
  });

  test("extractObjectProperties handles double-quoted backslash escapes", () => {
    const slice = `{ id: "a", name: "She said \\"hi\\"" }`;
    const props = extractObjectProperties(slice, ["id", "name"]);
    expect(props.name).toBe(`She said "hi"`);
  });

  test("extractObjectProperties tolerates // comments containing fake property keys", () => {
    // A line comment containing the substring `name: "comment-impostor"`
    // must not pollute extraction. The walker enters sl_comment state
    // on `//` and exits on `\n`, so identifier-like tokens inside the
    // comment are never inspected.
    const slice = `{
      id: "real",
      // name: "comment-impostor"
      name: "real-name",
    }`;
    const props = extractObjectProperties(slice, ["id", "name"]);
    expect(props.id).toBe("real");
    expect(props.name).toBe("real-name");
  });

  test("extractObjectProperties supports quoted property keys (round-10 #0002)", () => {
    // Devin Review round-10 flagged that the previous identifier-only
    // implementation would silently skip an entry whose keys were
    // quoted (`{ "id": "v" }`) — common when JSON-shaped object
    // literals are pasted into a TS file. The lexer now also accepts
    // a depth-1 string literal as a candidate KEY when not awaiting a
    // value after a colon.
    const dq = `{ "id": "double-id", "name": "double-name" }`;
    const dqProps = extractObjectProperties(dq, ["id", "name"]);
    expect(dqProps.id).toBe("double-id");
    expect(dqProps.name).toBe("double-name");

    const sq = `{ 'id': 'single-id', 'name': 'single-name' }`;
    const sqProps = extractObjectProperties(sq, ["id", "name"]);
    expect(sqProps.id).toBe("single-id");
    expect(sqProps.name).toBe("single-name");

    // Mixed quoted + unquoted keys in the same object.
    const mixed = `{ "id": "q-id", name: "u-name" }`;
    const mixedProps = extractObjectProperties(mixed, ["id", "name"]);
    expect(mixedProps.id).toBe("q-id");
    expect(mixedProps.name).toBe("u-name");

    // A nested quoted-key object must not leak into the parent.
    const nested = `{
      id: "outer",
      meta: { "name": "inner-imposter" },
      name: "outer-real",
    }`;
    const nestedProps = extractObjectProperties(nested, ["id", "name"]);
    expect(nestedProps.id).toBe("outer");
    expect(nestedProps.name).toBe("outer-real");
  });

  test("extractTopLevelScalar returns null for comment-only values (round-10 #0001)", () => {
    // Devin Review round-10 flagged that `extractTopLevelScalar` would
    // return the literal string `"# only a comment"` for an input
    // where the value region is entirely a YAML comment. Per
    // YAML 1.2 §6.6 that's a null scalar; the round-10 fix adds an
    // explicit start-of-line `#` branch and an empty-after-strip
    // branch, both returning null.
    expect(extractTopLevelScalar("id: # only a comment\n", "id")).toBeNull();
    // Indented `#` (after the colon, still no preceding non-# tokens)
    // also indicates a comment-only value.
    expect(extractTopLevelScalar("id:   # leading whitespace then comment\n", "id")).toBeNull();
    // No value at all → YAML null.
    expect(extractTopLevelScalar("id:\n", "id")).toBeNull();
    // Trailing-whitespace-only value → also YAML null.
    expect(extractTopLevelScalar("id:    \n", "id")).toBeNull();
    // A non-empty value with a trailing comment still extracts the
    // value (regression guard for the existing happy path).
    expect(extractTopLevelScalar("id: foo  # trailing comment\n", "id")).toBe("foo");
    // A `#` adjacent to a non-whitespace token is literal per YAML §6.6.
    expect(extractTopLevelScalar("id: foo#bar\n", "id")).toBe("foo#bar");
  });

  test("extractCategoriesBlock rejects unanchored matches (round-10 #0004)", () => {
    // The replacement regex `/^const CATEGORIES\b[ \t]*[:=]/m` only
    // matches a top-level declaration. We can't fault-inject directly
    // (the helper reads CreatePage.tsx from disk), but we can verify
    // the regex itself rejects the false-match patterns called out in
    // the finding: `const CATEGORIES_METADATA` (underscore suffix,
    // word boundary fails), and a comment line `// const CATEGORIES`
    // (not at start of line).
    const declRe = /^const CATEGORIES\b[ \t]*[:=]/m;
    expect(declRe.test("const CATEGORIES: Record<string, X> = {}")).toBe(true);
    expect(declRe.test("const CATEGORIES = {}")).toBe(true);
    expect(declRe.test("const CATEGORIES_METADATA = {}")).toBe(false);
    expect(declRe.test("// const CATEGORIES — legacy registry")).toBe(false);
    expect(declRe.test("  const CATEGORIES = {}")).toBe(false); // indented → not top level
    // Multi-line case: a decoy comment ABOVE the real declaration
    // must not block the legitimate match.
    const realistic =
      "// const CATEGORIES — used to live here\n" +
      "const CATEGORIES: Record<string, X> = {}\n";
    const m = declRe.exec(realistic);
    expect(m).not.toBeNull();
    expect(m && m.index).toBe(realistic.indexOf("const CATEGORIES:"));
  });

  test("REPO_ROOT was located by walking up to the workspace sentinel (round-11 #0006)", () => {
    // Devin Review round-11 flagged the previous hardcoded six-level
    // `..` chain as fragile. The replacement walks upward looking for
    // a directory that contains BOTH a `Cargo.toml` with a top-level
    // `[workspace]` table AND a `templates/` directory. The test below
    // pins down the invariants the `findRepoRoot` helper relies on so
    // a future refactor can't silently regress them.

    // 1. The discovered REPO_ROOT actually contains the sentinel pair.
    expect(existsSync(join(REPO_ROOT, "Cargo.toml"))).toBe(true);
    expect(existsSync(join(REPO_ROOT, "templates"))).toBe(true);
    // 2. That Cargo.toml carries the `[workspace]` table header —
    //    distinguishing the workspace manifest from any per-crate
    //    Cargo.toml the walker might have walked past.
    const cargoBody = readFileSync(join(REPO_ROOT, "Cargo.toml"), "utf8");
    expect(/^\[workspace\]/m.test(cargoBody)).toBe(true);
    // 3. REPO_ROOT must be an ancestor of __dirname (the walker should
    //    not have crossed a sibling tree). We deliberately do NOT
    //    assert anything about REPO_ROOT's basename — contributors
    //    routinely clone into custom directory names (`tessera-fork`,
    //    `tessera-experimental`, `T1`), and the smoke suite must work
    //    in every such layout.
    expect(__dirname.startsWith(REPO_ROOT + sep) || __dirname === REPO_ROOT).toBe(true);
  });
});
