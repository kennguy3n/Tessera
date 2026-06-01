/**
 * 15: subsequence-based fuzzy matcher used by the
 * Cmd+K command palette and the global cross-artifact search.
 *
 * Why subsequence (not Levenshtein / trigrams / BM25)?
 *
 *   - The user is filtering a small set (≤ ~5k items: commands +
 *     artifacts) interactively as they type. They expect "sf" to
 *     match "Sheet Editor", "Sources Page", "Settings Form" — i.e.
 *     in-order character matching is the mental model, not
 *     edit-distance.
 *   - Subsequence matching is O(query × candidate) per item, no
 *     index build, no precomputation, and produces stable rankings
 *     under append (typing one more character can never re-order
 *     two items whose previous scores were equal).
 *   - The bonus structure mirrors VSCode / Sublime / Helix command
 *     palette UX: prefix match > consecutive run > word-boundary
 *     match > camel-case match > scattered. That ordering is what
 *     users have built decade-plus muscle memory around, so
 *     reusing it makes Cmd+K feel familiar on day one.
 *
 * The scorer returns `null` for non-matches so callers can filter
 * with `.flatMap(item => { const s = score(...); return s ? [{...,
 * score: s}] : []; })` — that pattern is faster than two passes
 * (filter then score) because it scores at most once per item.
 *
 * Matched indices are returned alongside the score so the UI can
 * render the matched characters as bold without re-running the
 * matcher. This is the "highlight matched chars" UX pattern from
 * fzf / VSCode quickopen.
 */

/**
 * The result of a successful fuzzy match: a numeric score
 * (higher = better) plus the indices in `candidate` that matched
 * each character of `query` in order. `matchedIndices.length`
 * always equals `query.length` for a successful match.
 *
 * `score` is **not** normalized — values across different queries
 * are NOT comparable. Within a single query, sort descending by
 * `score` to get the best matches first.
 */
export interface FuzzyMatchResult {
  score: number;
  matchedIndices: number[];
}

const BONUS_PREFIX_MATCH = 12;
const BONUS_CONSECUTIVE = 8;
const BONUS_WORD_BOUNDARY = 6;
const BONUS_CAMEL_BOUNDARY = 4;
const BONUS_EXACT_CASE = 1;
const PENALTY_GAP = -1;

function isWordBoundary(prev: string | undefined): boolean {
  if (prev === undefined) return true;
  return /[\s\-_./\\]/.test(prev);
}

function isCamelBoundary(prev: string | undefined, curr: string): boolean {
  if (prev === undefined) return false;
  return /[a-z0-9]/.test(prev) && /[A-Z]/.test(curr);
}

/**
 * Score `candidate` against `query` using subsequence matching with
 * positional bonuses. Returns `null` if `query` is not a
 * case-insensitive subsequence of `candidate`.
 *
 * Empty `query` matches every candidate with score `0` and no
 * highlighted indices — callers usually short-circuit that case
 * before calling, but the contract is documented so command-palette
 * "show everything" behaviour is well-defined.
 *
 * Examples:
 *
 *   - `fuzzyMatch("sf", "Sheet Editor")` → match (prefix bonus on `s`,
 *     word-boundary bonus on `e`-after-space NOT applied since "f"
 *     matches mid-word; result is a positive but modest score).
 *   - `fuzzyMatch("sed", "Sheet Editor")` → strong match (prefix
 *     bonus on `s`, word-boundary bonus on `e` after the space, and
 *     consecutive bonus on `d`).
 *   - `fuzzyMatch("xyz", "Sheet Editor")` → `null` (no subsequence).
 */
export function fuzzyMatch(
  query: string,
  candidate: string,
): FuzzyMatchResult | null {
  if (query.length === 0) {
    return { score: 0, matchedIndices: [] };
  }
  if (candidate.length === 0) {
    return null;
  }

  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  const matchedIndices: number[] = [];

  let score = 0;
  let qi = 0;
  let prevMatchIdx = -2; // -2 so the first match never "looks consecutive"

  for (let ci = 0; ci < candidate.length && qi < q.length; ci++) {
    if (q[qi] === c[ci]) {
      let charScore = 1;
      if (ci === 0) {
        charScore += BONUS_PREFIX_MATCH;
      }
      if (ci === prevMatchIdx + 1 && prevMatchIdx >= 0) {
        charScore += BONUS_CONSECUTIVE;
      }
      if (isWordBoundary(candidate[ci - 1])) {
        charScore += BONUS_WORD_BOUNDARY;
      }
      if (isCamelBoundary(candidate[ci - 1], candidate[ci])) {
        charScore += BONUS_CAMEL_BOUNDARY;
      }
      if (query[qi] === candidate[ci]) {
        charScore += BONUS_EXACT_CASE;
      }
      score += charScore;
      matchedIndices.push(ci);
      prevMatchIdx = ci;
      qi++;
    } else {
      if (qi > 0) score += PENALTY_GAP;
    }
  }

  if (qi < q.length) return null;
  return { score, matchedIndices };
}

/**
 * Convenience wrapper: given a list of items and a `getText`
 * accessor, return the items whose text fuzzy-matches `query`,
 * sorted by score descending. Items with equal scores retain their
 * input order (stable sort).
 *
 * When `query` is empty, every item is returned in input order
 * with `score: 0` and `matchedIndices: []` — the command palette
 * uses this to show all commands before the user has typed
 * anything.
 *
 * The `limit` parameter caps the returned list, applied **after**
 * the sort so the top-N are returned. Defaults to `Infinity`
 * (no cap).
 */
export function fuzzyFilter<T>(
  items: ReadonlyArray<T>,
  query: string,
  getText: (item: T) => string,
  limit: number = Infinity,
): Array<{ item: T; score: number; matchedIndices: number[] }> {
  if (query.length === 0) {
    const all = items.map((item) => ({
      item,
      score: 0,
      matchedIndices: [] as number[],
    }));
    return Number.isFinite(limit) ? all.slice(0, limit) : all;
  }
  const matched: Array<{
    item: T;
    score: number;
    matchedIndices: number[];
    originalIndex: number;
  }> = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const result = fuzzyMatch(query, getText(item));
    if (result) {
      matched.push({
        item,
        score: result.score,
        matchedIndices: result.matchedIndices,
        originalIndex: i,
      });
    }
  }
  matched.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.originalIndex - b.originalIndex;
  });
  const trimmed = Number.isFinite(limit) ? matched.slice(0, limit) : matched;
  return trimmed.map(({ item, score, matchedIndices }) => ({
    item,
    score,
    matchedIndices,
  }));
}
