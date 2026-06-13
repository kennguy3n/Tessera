import type { SubstrateMemoryInfo } from "../types/ipc";

/**
 * Display helpers for the memory plane (MemoryPage).
 *
 * The substrate exposes a fine-grained decay state machine
 * (`candidate → reinforced → consolidated → canonical`, plus
 * `superseded → archived` and `deleted`; see
 * `tessera_substrate::manager::memory_state_str`). For the "what
 * Tessera knows" dashboard we collapse those seven states into three
 * user-facing buckets — **active**, **fading**, **archived** — so a
 * non-technical user can reason about retention at a glance while the
 * raw state stays available for the detail row. Keeping the mapping
 * here (pure, React-free) makes the bucket/filter logic unit-testable
 * and reusable by the search + filter controls.
 */

/**
 * Raw substrate decay states that count as "active" — i.e. still part
 * of the live working set. Mirrors the working-set states emitted by
 * `tessera_substrate::manager::memory_state_str` (`candidate`,
 * `reinforced`, `consolidated`, `canonical`); `superseded` / `archived`
 * / `deleted` are excluded. Values are compared case-insensitively, so
 * callers should lowercase the wire value before lookup.
 */
export const ACTIVE_MEMORY_STATES: ReadonlySet<string> = new Set([
  "candidate",
  "reinforced",
  "consolidated",
  "canonical",
]);

/**
 * True when a raw substrate decay `state` belongs to the live working
 * set (see {@link ACTIVE_MEMORY_STATES}). Lowercases the input so a
 * PascalCase wire value (e.g. `"Canonical"`) still matches.
 */
export function isActiveMemoryState(state: string): boolean {
  return ACTIVE_MEMORY_STATES.has(state.toLowerCase());
}

export type DecayBucket = "active" | "fading" | "archived";

export const DECAY_BUCKETS: readonly DecayBucket[] = [
  "active",
  "fading",
  "archived",
];

/** Raw states that are on their way out but still retained. */
const FADING_STATES: ReadonlySet<string> = new Set(["superseded"]);

/**
 * Collapse a raw substrate decay state into one of the three
 * user-facing buckets. Unknown / future states fall through to
 * `archived` (the most conservative "not part of the working set"
 * bucket) so a Rust-side enum addition never silently vanishes from
 * the filter UI.
 */
export function decayBucket(state: string): DecayBucket {
  const lowered = state.toLowerCase();
  if (ACTIVE_MEMORY_STATES.has(lowered)) return "active";
  if (FADING_STATES.has(lowered)) return "fading";
  return "archived";
}

/** Map a decay bucket to a `StatusBadge` variant. */
export function decayBadgeVariant(
  bucket: DecayBucket,
): "success" | "warning" | "error" | "info" {
  switch (bucket) {
    case "active":
      return "success";
    case "fading":
      return "warning";
    case "archived":
      return "info";
  }
}

/**
 * Human label for an observation type (`entity`, `fact`, `task`,
 * `decision`, …). Falls back to a title-cased version of the raw tag
 * so an unrecognized type still renders sensibly.
 */
export function observationTypeLabel(observationType: string): string {
  const known: Record<string, string> = {
    entity: "Entity",
    fact: "Fact",
    task: "Task",
    decision: "Decision",
    question: "Question",
  };
  const lowered = observationType.toLowerCase();
  if (known[lowered]) return known[lowered];
  return lowered
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export interface MemoryFilter {
  /** Restrict to a single decay bucket, or `"all"`. */
  bucket: DecayBucket | "all";
  /** Case-insensitive substring matched against content + type. */
  query: string;
}

/**
 * Apply the MemoryPage filter (bucket + free-text search) to a memory
 * list. Pure so the page can `useMemo` it and tests can assert the
 * filtering contract directly. Matching is case-insensitive and spans
 * the memory content and its observation type.
 */
export function filterMemories(
  memories: SubstrateMemoryInfo[],
  filter: MemoryFilter,
): SubstrateMemoryInfo[] {
  const q = filter.query.trim().toLowerCase();
  return memories.filter((m) => {
    if (filter.bucket !== "all" && decayBucket(m.state) !== filter.bucket) {
      return false;
    }
    if (!q) return true;
    return (
      m.content.toLowerCase().includes(q) ||
      m.observationType.toLowerCase().includes(q)
    );
  });
}

/** Count memories per decay bucket (for the filter chips). */
export function countByBucket(
  memories: SubstrateMemoryInfo[],
): Record<DecayBucket, number> {
  const counts: Record<DecayBucket, number> = {
    active: 0,
    fading: 0,
    archived: 0,
  };
  for (const m of memories) {
    counts[decayBucket(m.state)] += 1;
  }
  return counts;
}

/** Format a retention score (0..1) as a whole-number percentage. */
export function formatRetention(score: number): string {
  const clamped = Math.max(0, Math.min(1, score));
  return `${Math.round(clamped * 100)}%`;
}

/**
 * Build a reusable predicate that tests whether arbitrary content mentions a
 * concept `label`, matched on word boundaries (so "Atlas" is not surfaced for
 * "Atlassian"). Labels with no word characters (e.g. pure punctuation/CJK
 * where `\b` is meaningless) fall back to a case-insensitive substring test.
 *
 * The regex (or lowercased needle) is compiled *once* here and captured in the
 * returned closure, so a caller correlating one concept against many memories
 * pays the compile cost a single time instead of per memory — the hot path for
 * the decay map's O(nodes × memories) correlation. Pure; shared with
 * {@link memoryMentionsConcept} so single-shot and batched callers match
 * identically.
 */
export function conceptMentionMatcher(
  label: string,
): (content: string) => boolean {
  const trimmed = label.trim();
  if (!trimmed) return () => false;
  if (/\w/.test(trimmed)) {
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`, "i");
    return (content: string) => re.test(content);
  }
  const needle = trimmed.toLowerCase();
  return (content: string) => content.toLowerCase().includes(needle);
}

/**
 * Whether a memory's content mentions a concept `label`. Single-shot
 * convenience over {@link conceptMentionMatcher}; shared by the concept-graph
 * evidence panel and the decay visualization so the two correlate concepts to
 * memories *identically* — a single source of truth for "which memories are
 * about this concept". Callers matching one label against many contents should
 * use {@link conceptMentionMatcher} directly to compile the matcher once.
 */
export function memoryMentionsConcept(label: string, content: string): boolean {
  return conceptMentionMatcher(label)(content);
}

/** Number of leading characters shown for an abbreviated source id. */
const SOURCE_ID_PREVIEW = 8;

/**
 * Abbreviate an opaque substrate source id for a compact citation label.
 * Shows the first {@link SOURCE_ID_PREVIEW} characters, appending an
 * ellipsis ONLY when the id was actually longer than that — so a short id
 * (e.g. `"abc"`) renders as `"abc"` rather than the misleading `"abc…"`.
 */
export function formatSourceId(sourceId: string): string {
  return sourceId.length > SOURCE_ID_PREVIEW
    ? `${sourceId.slice(0, SOURCE_ID_PREVIEW)}…`
    : sourceId;
}

/**
 * Sort memories by retention strength (descending) for the default
 * dashboard order. The primary key is the retention score; ties break
 * on the strongest discrete signals (pins, then corroboration), then
 * the content for a fully deterministic order regardless of the order
 * the substrate emitted rows.
 */
export function sortByRetention(
  memories: SubstrateMemoryInfo[],
): SubstrateMemoryInfo[] {
  return [...memories].sort((a, b) => {
    if (b.retentionScore !== a.retentionScore) {
      return b.retentionScore - a.retentionScore;
    }
    if (b.pinCount !== a.pinCount) return b.pinCount - a.pinCount;
    if (b.corroborationCount !== a.corroborationCount) {
      return b.corroborationCount - a.corroborationCount;
    }
    return a.content.localeCompare(b.content);
  });
}
