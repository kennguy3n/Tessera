/**
 * Phase 15 Task 24 — line-level LCS diff for artifact version
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
 * Time / memory: O(N * M). Acceptable for two artifact-document
 * versions (largest in practice <50K lines / few MB). For
 * pathological inputs we cap at MAX_LINES per side and degrade to a
 * single replace block beyond the cap — preferred over a UI hang.
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

const MAX_LINES = 50_000;

/**
 * Split content into lines, stripping the line-ending convention
 * difference (CRLF / CR / LF all collapse to a single LF for the
 * comparison). Empty input → `[""]` so a single-line empty diff has
 * a row to render rather than collapsing into a no-op.
 */
export function splitLines(content: string): string[] {
  if (content.length === 0) return [""];
  return content
    .replace(/\r\n?/g, "\n")
    .split("\n");
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
  // and `b[0..j)`. We allocate as Int32Array rows for memory
  // efficiency on large inputs (50K * 50K = 2.5B i32 = 10 GB would
  // explode; the MAX_LINES guard above bounds this at the cap).
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
