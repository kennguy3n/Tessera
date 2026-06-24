/**
 * line-level LCS diff for artifact version
 * comparison.
 *
 * No external diff library: keep the bundle small by reimplementing
 * Hunt-Szymanski style longest-common-subsequence at the line level.
 * The output is a list of edit operations (`equal` / `add` /
 * `remove`) suitable for both inline and side-by-side rendering.
 *
 * Algorithm: classical O(N*M) dynamic-programming LCS table over
 * line arrays, then a single-pass backtrack to produce the diff
 * script. We treat each line as an opaque token; whitespace at end
 * of line is preserved (so a trailing-blank-line edit is detected),
 * but we DO strip a single trailing `\r` from each line so files
 * authored on Windows and Linux compare as equal when the only
 * difference is the line-ending convention.
 *
 * Time / memory: O(N * M). The DP table is a `(N+1) × (M+1)` array
 * of `Int32Array` rows — 4 bytes per cell. We cap inputs at
 * `MAX_LINES = 5_000` per side, which bounds the table at ~100 MB
 * (`5_001² × 4 B ≈ 95 MB`) and the back-trace at O(N + M). For
 * comparison, the previous cap of 50_000 would have permitted a
 * `50_001² × 4 B ≈ 9.3 GB` allocation, which V8 cannot satisfy (the
 * heap ceiling on the renderer is ~4 GB) — the tab would have
 * crashed with `RangeError: Array buffer allocation failed` or just
 * OOM-killed by the renderer process before reporting back.
 *
 * 5_000 lines comfortably covers the realistic artifact-document
 * size envelope (Markdown / typst / code / outline editors all
 * produce documents well under 5 K lines in practice — a 5 K-line
 * Markdown file is ≈ 200 KB of text and would render to ~150
 * pages). Beyond the cap we degrade to a single replace block
 * (all `before` lines as removes, all `after` lines as adds) —
 * preferred over a UI hang or OOM. The compare-view surface in
 * `VersionHistory` displays a banner explaining the degradation so
 * the user knows the diff is approximate.
 *
 * Future optimisation paths (deferred):
 *
 *  - Hirschberg's algorithm reduces memory to O(min(m, n)) by
 *    recursively splitting the problem and keeping only two DP
 *    rows at a time. Break-even vs. the classical table is roughly
 *    2-3 K lines on typical hardware because the constant factor
 *    (recursive allocations, backtracking complexity) outweighs
 *    the savings on small inputs.
 *  - Offloading `diffLines` into a Web Worker eliminates the
 *    main-thread UI hitch entirely — preferable to Hirschberg as
 *    a first intervention because the existing classical
 *    implementation is fast enough off the main thread; we just
 *    don't want it competing with React reconciliation. A worker
 *    is also the natural home for the future Hirschberg variant.
 *
 *  If a real user-facing hitch is reported, the worker offload is
 *  the lower-risk change; Hirschberg is the longer-term path if
 *  even the worker thread starts spending too long on the DP
 *  table.
 */

export type DiffOp = "equal" | "add" | "remove";

export interface DiffEntry {
  op: DiffOp;
  /** 0-based line number in the OLD document (or null for `add`). */
  oldLine: number | null;
  /** 0-based line number in the NEW document (or null for `remove`). */
  newLine: number | null;
  text: string;
}

export interface DiffSummary {
  added: number;
  removed: number;
  unchanged: number;
}

/**
 * Per-side line-count ceiling for the LCS DP table. See the module
 * doc comment for the memory-budget derivation (`5_001² × 4 B`
 * ≈ 95 MB peak, well inside the renderer's 4 GB heap with room for
 * the rest of the React tree). Inputs exceeding this cap take the
 * bypass branch below.
 */
const MAX_LINES = 5_000;

/**
 * Split content into lines, stripping the line-ending convention
 * difference (CRLF / CR / LF all collapse to a single LF for the
 * comparison). Empty input → `[""]` so a single-line empty diff has
 * a row to render rather than collapsing into a no-op.
 */
export function splitLines(content: string): string[] {
  if (content.length === 0) return [""];
  return content.replace(/\r\n?/g, "\n").split("\n");
}

/**
 * Compute a line-level diff script for `before` → `after`.
 *
 * Returns the operations in document order. Equal lines appear with
 * `op === "equal"` and matching `oldLine` / `newLine` indices. Added
 * lines have a `newLine` index but `oldLine === null`; removed lines
 * have `oldLine` but `newLine === null`.
 */
export function diffLines(
  before: string,
  after: string,
): { entries: DiffEntry[]; summary: DiffSummary } {
  const a = splitLines(before);
  const b = splitLines(after);

  // Pathological-input bypass — produce a single replace block.
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    const entries: DiffEntry[] = [];
    a.forEach((text, i) =>
      entries.push({ op: "remove", oldLine: i, newLine: null, text }),
    );
    b.forEach((text, i) =>
      entries.push({ op: "add", oldLine: null, newLine: i, text }),
    );
    return {
      entries,
      summary: { added: b.length, removed: a.length, unchanged: 0 },
    };
  }

  // Build the LCS DP table. `lcs[i][j]` = length of LCS of `a[0..i)`
  // and `b[0..j)`. We allocate as `Int32Array` rows for memory
  // efficiency on large inputs — the bypass branch above caps both
  // dimensions at `MAX_LINES`, so the peak allocation here is
  // `(MAX_LINES + 1)² × 4 B ≈ 95 MB` at the documented 5_000-line
  // ceiling. A larger ceiling (e.g. the historical 50_000) would
  // overshoot the renderer's heap (≈ 4 GB) by a factor of ~2 and
  // crash the tab with `Array buffer allocation failed`.
  const m = a.length;
  const n = b.length;
  const lcs: Int32Array[] = [];
  for (let i = 0; i <= m; i += 1) {
    lcs.push(new Int32Array(n + 1));
  }
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        lcs[i][j] = lcs[i - 1][j - 1] + 1;
      } else if (lcs[i - 1][j] >= lcs[i][j - 1]) {
        lcs[i][j] = lcs[i - 1][j];
      } else {
        lcs[i][j] = lcs[i][j - 1];
      }
    }
  }

  // Backtrack through the table to build the diff script in
  // reverse, then reverse the result. `equal` edges descend
  // diagonally; `remove` edges descend along the `a` axis; `add`
  // edges descend along the `b` axis.
  const entries: DiffEntry[] = [];
  let added = 0;
  let removed = 0;
  let unchanged = 0;
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      entries.push({
        op: "equal",
        oldLine: i - 1,
        newLine: j - 1,
        text: a[i - 1],
      });
      unchanged += 1;
      i -= 1;
      j -= 1;
    } else if (j > 0 && (i === 0 || lcs[i][j - 1] >= lcs[i - 1][j])) {
      entries.push({
        op: "add",
        oldLine: null,
        newLine: j - 1,
        text: b[j - 1],
      });
      added += 1;
      j -= 1;
    } else {
      entries.push({
        op: "remove",
        oldLine: i - 1,
        newLine: null,
        text: a[i - 1],
      });
      removed += 1;
      i -= 1;
    }
  }
  entries.reverse();
  return { entries, summary: { added, removed, unchanged } };
}
