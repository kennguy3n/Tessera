import { ACTIVE_MEMORY_STATES, type SubstrateMemoryInfo } from "../types/ipc";

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
