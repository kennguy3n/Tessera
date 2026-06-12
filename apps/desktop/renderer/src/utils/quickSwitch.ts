/**
 * Pure ranking + data-shaping helpers for the global quick switcher
 * (Obsidian's Ctrl/Cmd+O). Kept free of React and `window.tessera` so
 * the ranking can be unit-tested in isolation and so the component
 * never re-implements scoring inline.
 *
 * The switcher is a single flat, ranked list spanning every navigable
 * entity — sources, artifacts, templates, automations, tasks, and the
 * app's own pages — mirroring Obsidian's file switcher (one list, a
 * type/path subtitle per row, no category headers). A flat list keeps
 * keyboard navigation linear and lets the view virtualise with a
 * uniform row height.
 *
 * Ranking model (see {@link rankQuickSwitchItems}):
 *
 *   - Empty query → "recents first": the user's recently-viewed items
 *     in recency order, then everything else in a stable kind order.
 *     This is the muscle-memory path — open the switcher, the thing
 *     you just looked at is row 0.
 *   - Non-empty query → fuzzy score (reusing {@link fuzzyMatch}) of the
 *     title, with a smaller contribution from the subtitle/keywords,
 *     plus a recency boost so a recently-viewed match outranks a cold
 *     one of equal textual score. Ties break by kind order then title.
 *
 * Scores are NOT comparable across queries (inherited from
 * `fuzzyMatch`); within one query, higher is better.
 */

import { fuzzyMatch } from "./fuzzyMatch";

/** The navigable entity kinds the switcher spans. */
export type QuickSwitchKind =
  | "artifact"
  | "source"
  | "template"
  | "automation"
  | "task"
  | "page";

/**
 * A single switcher row. `id` is globally unique across kinds
 * (prefixed by kind, e.g. `artifact:<uuid>`) so React keys and the
 * recency join never collide between, say, a source and an artifact
 * that happen to share a UUID.
 */
export interface QuickSwitchItem {
  /** Globally-unique row id, e.g. `artifact:<uuid>`. */
  id: string;
  kind: QuickSwitchKind;
  /** Primary, fuzzy-matched, highlighted text. */
  title: string;
  /** Secondary muted text (type, path, status). Not highlighted. */
  subtitle: string;
  /** Extra search-only text (never displayed) folded into matching. */
  keywords: string;
  /** react-router destination activated on Enter / click. */
  to: string;
  /**
   * Optional id used to join against the recently-viewed list (for
   * artifacts, the bare artifact UUID). Absent for kinds with no
   * recency signal.
   */
  recentKey?: string;
}

/** A ranked row plus the title indices to highlight. */
export interface RankedQuickSwitchItem {
  item: QuickSwitchItem;
  /** Indices into `item.title` to render emphasised. May be empty. */
  matchedIndices: number[];
}

/**
 * Stable display/tie-break order across kinds. Artifacts and sources
 * are a user's primary content so they sort ahead of scaffolding
 * (templates) and chrome (pages) when textual scores tie.
 */
export const QUICK_SWITCH_KIND_ORDER: readonly QuickSwitchKind[] = [
  "artifact",
  "source",
  "task",
  "automation",
  "template",
  "page",
];

const KIND_RANK: Record<QuickSwitchKind, number> = QUICK_SWITCH_KIND_ORDER.reduce(
  (acc, kind, i) => {
    acc[kind] = i;
    return acc;
  },
  {} as Record<QuickSwitchKind, number>,
);

/**
 * Title fuzzy score is the dominant signal; a match found only in the
 * subtitle/keywords contributes at a discount so a literal title hit
 * always outranks an incidental keyword hit.
 */
const AUX_WEIGHT = 0.4;

/**
 * Per-rank recency boost. Index 0 (most recent) gets the full bonus,
 * tapering linearly to zero past {@link RECENCY_WINDOW}. Tuned to be
 * large enough to float a recent item above a cold item of similar
 * textual score, but never enough to beat a clearly stronger match.
 */
const RECENCY_BONUS = 6;
const RECENCY_WINDOW = 12;

function recencyBoost(rank: number): number {
  if (rank < 0 || rank >= RECENCY_WINDOW) return 0;
  return (RECENCY_BONUS * (RECENCY_WINDOW - rank)) / RECENCY_WINDOW;
}

/**
 * Score one item against a (non-empty) query. Returns `null` when the
 * query is not a fuzzy subsequence of either the title or the
 * search-only `keywords` text. `matchedIndices` is populated only for
 * a title hit (keywords are not displayed, so there is nothing to
 * highlight for a keyword-only hit).
 *
 * Note: `subtitle` is deliberately NOT searched. It is display-only
 * and prefixes the kind label ("Artifact · …", "Source · …"), so
 * folding it into matching would make every artifact match "art",
 * every source match "source", etc. The meaningful searchable bits of
 * the subtitle (a source's path, a template's type) are mirrored into
 * `keywords` by the aggregator, so dropping the subtitle here loses no
 * real recall while removing that noise.
 */
export function scoreQuickItem(
  query: string,
  item: QuickSwitchItem,
): { score: number; matchedIndices: number[] } | null {
  const titleMatch = fuzzyMatch(query, item.title);
  const auxText = item.keywords.trim();
  const auxMatch = auxText.length > 0 ? fuzzyMatch(query, auxText) : null;

  if (!titleMatch && !auxMatch) return null;

  const titleScore = titleMatch ? titleMatch.score : 0;
  const auxScore = auxMatch ? auxMatch.score * AUX_WEIGHT : 0;
  // A title hit owns the highlight; an aux-only hit highlights nothing.
  const matchedIndices = titleMatch ? titleMatch.matchedIndices : [];
  return { score: titleScore + auxScore, matchedIndices };
}

export interface RankQuickSwitchOptions {
  items: readonly QuickSwitchItem[];
  query: string;
  /**
   * Recently-viewed keys (artifact UUIDs) in most-recent-first order.
   * Joined against `item.recentKey`.
   */
  recentKeys?: readonly string[];
  /** Hard cap on returned rows (post-rank). Defaults to 50. */
  limit?: number;
}

/**
 * Rank items for display. See the module header for the model.
 *
 * The result is always capped to `limit` rows so the view stays
 * responsive on large libraries even before virtualisation; the empty
 * query path is capped too (recents + the head of the stable order).
 */
export function rankQuickSwitchItems({
  items,
  query,
  recentKeys = [],
  limit = 50,
}: RankQuickSwitchOptions): RankedQuickSwitchItem[] {
  const recentRank = new Map<string, number>();
  recentKeys.forEach((key, i) => {
    if (!recentRank.has(key)) recentRank.set(key, i);
  });

  const q = query.trim();

  if (q.length === 0) {
    // Recents first (in recency order), then everything else in a
    // stable kind→title order. Items without a recentKey, or whose
    // key is not in the recents list, fall into the "rest" bucket.
    const recent: QuickSwitchItem[] = [];
    const rest: QuickSwitchItem[] = [];
    for (const item of items) {
      const rank = item.recentKey
        ? recentRank.get(item.recentKey)
        : undefined;
      if (rank !== undefined) recent.push(item);
      else rest.push(item);
    }
    recent.sort((a, b) => {
      const ra = recentRank.get(a.recentKey as string) ?? 0;
      const rb = recentRank.get(b.recentKey as string) ?? 0;
      return ra - rb;
    });
    rest.sort(compareByKindThenTitle);
    return [...recent, ...rest]
      .slice(0, limit)
      .map((item) => ({ item, matchedIndices: [] }));
  }

  const scored: Array<{
    item: QuickSwitchItem;
    score: number;
    matchedIndices: number[];
    originalIndex: number;
  }> = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const result = scoreQuickItem(q, item);
    if (!result) continue;
    const rank = item.recentKey ? recentRank.get(item.recentKey) : undefined;
    const boost = rank !== undefined ? recencyBoost(rank) : 0;
    scored.push({
      item,
      score: result.score + boost,
      matchedIndices: result.matchedIndices,
      originalIndex: i,
    });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const kindDelta = KIND_RANK[a.item.kind] - KIND_RANK[b.item.kind];
    if (kindDelta !== 0) return kindDelta;
    return a.originalIndex - b.originalIndex;
  });

  return scored
    .slice(0, limit)
    .map(({ item, matchedIndices }) => ({ item, matchedIndices }));
}

function compareByKindThenTitle(a: QuickSwitchItem, b: QuickSwitchItem): number {
  const kindDelta = KIND_RANK[a.kind] - KIND_RANK[b.kind];
  if (kindDelta !== 0) return kindDelta;
  return a.title.localeCompare(b.title);
}

/** Human label for a kind, shown as the row's type badge. */
export function kindLabel(kind: QuickSwitchKind): string {
  switch (kind) {
    case "artifact":
      return "Artifact";
    case "source":
      return "Source";
    case "template":
      return "Template";
    case "automation":
      return "Automation";
    case "task":
      return "Task";
    case "page":
      return "Page";
  }
}
