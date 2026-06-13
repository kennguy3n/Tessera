/**
 * Time-based decay model for the concept graph.
 *
 * The substrate's memory plane carries a real decay state machine and
 * real timestamps (`SubstrateMemoryInfo`: `state`
 * candidate→reinforced→consolidated→canonical→superseded→archived,
 * `retentionScore` 0..1, `createdAt` / `lastAccessedAt` unix-seconds,
 * `pinCount`). Concept-graph *nodes* themselves carry no timestamps — the
 * wire `GraphView` is purely structural — so we derive each concept's
 * recency/relevance by associating it with the memories that mention it
 * (the same word-boundary correlation the evidence panel uses) and
 * aggregating their real fields. There is **no synthetic time series**:
 * every value here traces back to a substrate memory record.
 *
 * This module is pure (no DOM/React/bridge): it builds the per-node decay
 * aggregate, the graph-wide time bounds for the scrubber, the
 * "as-of"/window membership test, and the opacity/size/color ramps the
 * renderers use to encode age. All unit-tested in isolation; the
 * component stays a thin shell that wires these to the canvas/SVG paint
 * and the time controls.
 */

import type { SubstrateMemoryInfo } from "../types/ipc";
import {
  conceptMentionMatcher,
  decayBucket,
  type DecayBucket,
} from "./memories";
import type { ConceptGraphNode } from "./conceptGraph";

/**
 * Decay/recency aggregate for one concept, derived from every memory that
 * mentions its label. All time fields are unix-seconds. A concept with no
 * associated memory has `memoryCount === 0` and null time/retention — it
 * is "timeless" (structural only) and the renderers treat it neutrally
 * rather than fabricating an age for it.
 */
export interface ConceptDecay {
  /** Earliest `createdAt` across associated memories (when the concept first appeared). */
  createdAt: number | null;
  /** Most recent `lastAccessedAt` across associated memories (freshness). */
  lastAccessedAt: number | null;
  /** Max `retentionScore` (0..1) across associated memories. */
  retention: number | null;
  /** Strongest (most-alive) decay bucket among associated memories. */
  bucket: DecayBucket | null;
  /** Total pins across associated memories (a strong retention signal). */
  pinCount: number;
  /** Number of memories mentioning this concept. */
  memoryCount: number;
}

/** A concept with no time/retention data — the neutral default. */
export const TIMELESS_DECAY: ConceptDecay = Object.freeze({
  createdAt: null,
  lastAccessedAt: null,
  retention: null,
  bucket: null,
  pinCount: 0,
  memoryCount: 0,
});

/** Rank buckets so we can keep the "most alive" one for a concept. */
const BUCKET_RANK: Record<DecayBucket, number> = {
  active: 2,
  fading: 1,
  archived: 0,
};

/**
 * Build a concept-id → {@link ConceptDecay} map by correlating each node
 * to the memories that mention its label (word-boundary match, shared
 * with the evidence panel) and aggregating their real decay fields.
 *
 * Complexity is O(nodes × memories) in the worst case, so callers should
 * compute it lazily — only when the decay overlay is actually enabled —
 * and memoize on `[nodes, memories]`. To keep the constant factor low we
 * compile each concept's word-boundary matcher *once* (via
 * {@link conceptMentionMatcher}) and reuse it across every memory, instead of
 * recompiling a regex per node×memory pair. Concepts with no matching memory
 * map to {@link TIMELESS_DECAY}.
 */
export function buildConceptDecayMap(
  nodes: ReadonlyArray<ConceptGraphNode>,
  memories: ReadonlyArray<SubstrateMemoryInfo>,
): Map<string, ConceptDecay> {
  const map = new Map<string, ConceptDecay>();
  for (const node of nodes) {
    let createdAt: number | null = null;
    let lastAccessedAt: number | null = null;
    let retention: number | null = null;
    let bucket: DecayBucket | null = null;
    let pinCount = 0;
    let memoryCount = 0;

    const mentions = conceptMentionMatcher(node.label);
    for (const mem of memories) {
      if (!mentions(mem.content)) continue;
      memoryCount++;
      pinCount += mem.pinCount;
      if (Number.isFinite(mem.createdAt)) {
        createdAt =
          createdAt === null ? mem.createdAt : Math.min(createdAt, mem.createdAt);
      }
      if (Number.isFinite(mem.lastAccessedAt)) {
        lastAccessedAt =
          lastAccessedAt === null
            ? mem.lastAccessedAt
            : Math.max(lastAccessedAt, mem.lastAccessedAt);
      }
      if (Number.isFinite(mem.retentionScore)) {
        const r = clamp01(mem.retentionScore);
        retention = retention === null ? r : Math.max(retention, r);
      }
      const b = decayBucket(mem.state);
      if (bucket === null || BUCKET_RANK[b] > BUCKET_RANK[bucket]) bucket = b;
    }

    map.set(
      node.id,
      memoryCount === 0
        ? TIMELESS_DECAY
        : { createdAt, lastAccessedAt, retention, bucket, pinCount, memoryCount },
    );
  }
  return map;
}

/** Inclusive time bounds (unix-seconds) for the scrubber + ramps. */
export interface TimeBounds {
  /** Earliest concept appearance, or null when no concept has time data. */
  min: number | null;
  /** Latest concept access, or null when no concept has time data. */
  max: number | null;
}

/**
 * Graph-wide time bounds across the decay map: the earliest `createdAt`
 * and the latest `lastAccessedAt`. Drives the time scrubber's range. Null
 * fields mean no concept in view carries time data (the time controls
 * hide in that case).
 */
export function computeTimeBounds(
  decay: ReadonlyMap<string, ConceptDecay>,
): TimeBounds {
  let min: number | null = null;
  let max: number | null = null;
  for (const d of decay.values()) {
    if (d.createdAt !== null) min = min === null ? d.createdAt : Math.min(min, d.createdAt);
    if (d.lastAccessedAt !== null) {
      max = max === null ? d.lastAccessedAt : Math.max(max, d.lastAccessedAt);
    }
    // A concept accessed earlier than any other's creation still widens
    // the lower bound; likewise a creation later than any access widens
    // the upper bound — so the window always spans every event.
    if (d.lastAccessedAt !== null) {
      min = min === null ? d.lastAccessedAt : Math.min(min, d.lastAccessedAt);
    }
    if (d.createdAt !== null) {
      max = max === null ? d.createdAt : Math.max(max, d.createdAt);
    }
  }
  return { min, max };
}

/**
 * Whether a concept existed at or before `asOf` (unix-seconds) — i.e. its
 * first associated memory was created by then. Timeless concepts (no time
 * data) are considered always-present so the scrubber never guts the
 * structural graph; the caller decides whether to dim them.
 */
export function isPresentAsOf(decay: ConceptDecay, asOf: number): boolean {
  if (decay.createdAt === null) return true;
  return decay.createdAt <= asOf;
}

/**
 * Recency of a concept relative to `asOf`, normalized to 0..1 against the
 * graph `bounds`: 1 = accessed right at `asOf`, decaying toward 0 the
 * longer ago (relative to the full span) it was last touched. Used to
 * drive opacity/size/color so "fresh" concepts pop and stale ones fade.
 * Timeless concepts (or a degenerate zero-width span) return `null` so the
 * caller can render them neutrally.
 */
export function recencyFraction(
  decay: ConceptDecay,
  asOf: number,
  bounds: TimeBounds,
): number | null {
  if (decay.lastAccessedAt === null || bounds.min === null || bounds.max === null) {
    return null;
  }
  const span = bounds.max - bounds.min;
  if (span <= 0) return 1;
  // Clamp the reference access time to `asOf` so a memory accessed *after*
  // the scrubber position doesn't read as "fresh" for that earlier instant.
  const ref = Math.min(decay.lastAccessedAt, asOf);
  const age = asOf - ref; // seconds since last access, as of the scrubber
  const t = 1 - age / span;
  return clamp01(t);
}

/** Node opacity for a recency fraction `t` (null → neutral mid opacity). */
export function decayOpacity(t: number | null): number {
  if (t === null) return 0.55;
  return 0.32 + clamp01(t) * 0.63; // 0.32 (stale) .. 0.95 (fresh)
}

/** Node radius multiplier for a recency fraction (null → 1, no change). */
export function decaySizeFactor(t: number | null): number {
  if (t === null) return 1;
  return 0.82 + clamp01(t) * 0.36; // 0.82 .. 1.18
}

/**
 * Color stops for the recency ramp (stale → fresh), light and dark
 * variants so the encoding keeps WCAG-friendly contrast against either
 * surface. Stale is a muted slate; fresh is a saturated emerald/teal that
 * reads as "alive". Pure hex (no CSS vars) because the canvas paints with
 * resolved colors and we interpolate between stops.
 */
const RAMP_LIGHT: ReadonlyArray<string> = ["#94a3b8", "#38bdf8", "#10b981"];
const RAMP_DARK: ReadonlyArray<string> = ["#475569", "#0ea5e9", "#34d399"];

/** Color for a no-time-data ("timeless") concept, per theme. */
const TIMELESS_COLOR: Record<"light" | "dark", string> = {
  light: "#cbd5e1",
  dark: "#334155",
};

/**
 * Map a recency fraction `t` (0..1, or null) to a ramp color for `theme`.
 * Interpolates linearly between the ramp stops. A null `t` (timeless)
 * returns the neutral timeless color. Deterministic and allocation-light.
 */
export function decayColor(t: number | null, theme: "light" | "dark"): string {
  if (t === null) return TIMELESS_COLOR[theme];
  const stops = theme === "dark" ? RAMP_DARK : RAMP_LIGHT;
  const clamped = clamp01(t);
  const segment = clamped * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(segment));
  const local = segment - i;
  return lerpHex(stops[i], stops[i + 1], local);
}

/** Evenly-spaced legend swatches for the recency ramp (oldest → newest). */
export function decayLegendStops(
  theme: "light" | "dark",
  count = 5,
): Array<{ t: number; color: string }> {
  const out: Array<{ t: number; color: string }> = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 1 : i / (count - 1);
    out.push({ t, color: decayColor(t, theme) });
  }
  return out;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Parse a `#rrggbb` string to [r,g,b]; tolerant of a leading `#`. */
function parseHex(hex: string): [number, number, number] {
  const h = hex.replace(/^#/, "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/** Linear RGB interpolation between two `#rrggbb` colors at `t` (0..1). */
export function lerpHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = parseHex(a);
  const [br, bg, bb] = parseHex(b);
  const clamped = clamp01(t);
  const r = Math.round(ar + (br - ar) * clamped);
  const g = Math.round(ag + (bg - ag) * clamped);
  const bl = Math.round(ab + (bb - ab) * clamped);
  return `#${toHex(r)}${toHex(g)}${toHex(bl)}`;
}

function toHex(v: number): string {
  return Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0");
}
