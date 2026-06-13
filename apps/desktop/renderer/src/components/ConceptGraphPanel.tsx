import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useCspNonce } from "../utils/cspNonce";
import { useConceptGraph } from "../hooks/useSubstrate";
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion";
import {
  compareCodepoint,
  computeDegrees,
  computeEdgeCurves,
  computeFitBox,
  computeForceLayout,
  filterGraphView,
  findNeighborInDirection,
  freezeView,
  highestDegreeNodeId,
  incidentTo,
  localGraphView,
  placeEdgeLabels,
  quadraticControlPoint,
  quadraticEdgePath,
  RELATION_LABELS,
  type ConceptGraphView,
  type ConceptNodeState,
  type ConceptRelation,
  type FitBox,
  type LabelCandidate,
  type Point,
  type PositionedNode,
  type SpatialDirection,
} from "../utils/conceptGraph";
import {
  computeViewSignature,
  defaultViewState,
  loadViewState,
  saveViewState,
  type ConceptGraphViewState,
} from "../utils/conceptGraphViewState";
import { CANVAS_RENDER_THRESHOLD } from "../utils/conceptGraphRenderer";
import {
  buildConceptDecayMap,
  computeTimeBounds,
  decayColor,
  decayLegendStops,
  decayOpacity,
  decaySizeFactor,
  isPresentAsOf,
  recencyFraction,
  type ConceptDecay,
  type TimeBounds,
} from "../utils/conceptGraphDecay";
import {
  activePresetId,
  findPreset,
  loadPresetStore,
  removePreset,
  savePresetStore,
  upsertPresetByName,
  type ConceptGraphPreset,
  type ConceptGraphPresetStore,
  type PresetFilter,
} from "../utils/conceptGraphPresets";
import ConceptGraphCanvas, {
  type CanvasNodeStyle,
} from "./ConceptGraphCanvas";
import { conceptMentionMatcher, formatSourceId } from "../utils/memories";
import type { SubstrateMemoryInfo } from "../types/ipc";

/**
 * Interactive node-link view of the knowledge-substrate concept graph,
 * rendered with a dependency-free SVG layer (no D3 / canvas / extra
 * graph library). Nodes are concepts; edges are typed relations (`is_a`,
 * `part_of`, `supersedes`, `contradicts`, …).
 *
 * The interaction model is modelled on Obsidian's graph view and then
 * extended for a *typed* knowledge graph:
 *   - a deterministic force-directed layout (computed in
 *     `utils/conceptGraph`) that the panel animates toward with an
 *     ease-out settle (skipped under `prefers-reduced-motion`);
 *   - fit-on-load + zoom-to-fit, fluid wheel-zoom and drag-to-pan;
 *   - hover/selection highlights the node and its neighbors and dims the
 *     rest; nodes can be dragged to reposition; a "local graph" mode
 *     restricts the view to a node's N-hop neighborhood;
 *   - legends double as filters — toggle relationship types and node
 *     kinds (lifecycle states); degree-based node sizing; and a graceful
 *     "show more" affordance when the substrate truncates the graph at
 *     the node cap.
 *
 * All non-trivial logic (defensive JSON parsing, the force layout, the
 * filter/neighborhood/fit math) lives in `utils/conceptGraph` so this
 * component stays a presentational + interaction shell over separately
 * unit-tested, deterministic functions.
 */

const STATE_COLORS: Record<ConceptNodeState, string> = {
  candidate: "var(--color-text-secondary, #6b7280)",
  canonical: "var(--color-primary, #7c3aed)",
  superseded: "var(--color-warning, #f59e0b)",
  contradicted: "var(--color-danger, #ef4444)",
  deleted: "var(--color-text-tertiary, #9ca3af)",
  unknown: "var(--color-text-secondary, #6b7280)",
};

const STATE_LABELS: Record<ConceptNodeState, string> = {
  candidate: "candidate",
  canonical: "canonical",
  superseded: "superseded",
  contradicted: "contradicted",
  deleted: "deleted",
  unknown: "unknown",
};

const RELATION_COLORS: Record<ConceptRelation, string> = {
  is_a: "#2563eb",
  part_of: "#0891b2",
  decided_by: "#7c3aed",
  supersedes: "#d97706",
  contradicts: "#dc2626",
  derived_from: "#059669",
  assigned_to: "#db2777",
  unknown: "#6b7280",
};

/**
 * Concrete (non-`var()`) node fills for the Canvas renderer, mirroring the
 * fallbacks baked into {@link STATE_COLORS}. The SVG path can use CSS
 * custom properties directly, but the canvas draws to a bitmap and needs
 * resolved colors; these brand hues read well on both light and dark
 * surfaces (the canvas resolves surface/label/stroke from tokens for true
 * theme parity).
 */
const STATE_CANVAS_COLORS: Record<ConceptNodeState, string> = {
  candidate: "#6b7280",
  canonical: "#7c3aed",
  superseded: "#f59e0b",
  contradicted: "#ef4444",
  deleted: "#9ca3af",
  unknown: "#6b7280",
};

/** Resolve the active color scheme from the `data-theme` override or OS. */
function detectColorScheme(): "light" | "dark" {
  if (typeof document !== "undefined") {
    const attr = document.documentElement.getAttribute("data-theme");
    if (attr === "dark") return "dark";
    if (attr === "light") return "light";
  }
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return "light";
}

export interface ConceptGraphPanelProps {
  /** Scope label forwarded to the bridge; `null`/omitted = default scope. */
  scope?: string | null;
  /** Initial upper bound on nodes pulled from the substrate. */
  maxNodes?: number;
  /**
   * Memory plane used to surface source evidence + citations for a
   * selected concept. When omitted the panel still renders the graph
   * and relationships; the evidence section is simply empty.
   */
  memories?: SubstrateMemoryInfo[];
  /** SVG canvas height in px. Width is responsive via viewBox. */
  height?: number;
  /** Optional heading rendered above the canvas. */
  title?: string;
  /** `data-testid` forwarded to the root element. */
  "data-testid"?: string;
}

const CANVAS_WIDTH = 720;
/** Hard ceiling on the node cap reachable via "show more" (perf guard). */
const NODE_CAP_CEILING = 600;
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 8;
/** Below this node count every label is shown; above it, labels are pruned. */
const LABEL_ALL_THRESHOLD = 36;
/** Edge labels are only ever shown wholesale below this edge count. */
const EDGE_LABEL_THRESHOLD = 24;
/** Fraction of the viewBox the canvas pans per arrow-key press. */
const KEYBOARD_PAN_STEP = 0.12;
/** Approx. width (px) of one edge-label glyph at the 9px label size. */
const EDGE_LABEL_CHAR_WIDTH = 5.2;
/** Horizontal padding (px) added to an edge-label collision box. */
const EDGE_LABEL_BOX_PADDING = 6;
/** Edge-label collision-box height (px), ~ the 9px glyph plus halo. */
const EDGE_LABEL_BOX_HEIGHT = 12;
/** Debounce (ms) for screen-reader live announcements. */
const ANNOUNCE_DEBOUNCE_MS = 250;
/** Debounce (ms) before persisting view state to localStorage. */
const PERSIST_DEBOUNCE_MS = 300;

/** Map an ArrowKey `event.key` to a spatial-navigation direction. */
const ARROW_DIRECTIONS: Record<string, SpatialDirection> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

/**
 * Static panel CSS, hoisted to a module-level constant so the rules are
 * identical for every mount and don't depend on props. The only dynamic
 * style is `.cg-detail`'s `max-height` (driven by the `height` prop),
 * applied inline on the element itself rather than baked into this
 * stylesheet — otherwise two panels with different `height` props mounted
 * at once would collide in the cascade. Motion is gated behind
 * `prefers-reduced-motion` so the CSS transitions (highlight dimming,
 * control affordances) honour the accessibility setting even though the
 * JS settle animation is gated separately in the component.
 */
const CONCEPT_GRAPH_STYLES = `
  .cg-panel {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-sm);
  }
  .cg-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--spacing-sm);
    flex-wrap: wrap;
  }
  .cg-title { margin: 0; font-size: var(--font-size-md, 1rem); }
  .cg-toolbar-controls {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm);
    flex-wrap: wrap;
  }
  .cg-controlbar {
    display: flex;
    align-items: center;
    gap: var(--spacing-xs);
    flex-wrap: wrap;
    padding: var(--spacing-xs) var(--spacing-sm);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md, 8px);
    background: var(--color-surface, #fff);
  }
  .cg-controlbar-group {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
  }
  .cg-controlbar-sep {
    width: 1px;
    align-self: stretch;
    background: var(--color-border);
    margin: 0 0.25rem;
  }
  .cg-iconbtn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.9rem;
    height: 1.9rem;
    padding: 0 0.5rem;
    font-size: var(--font-size-sm);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    background: var(--color-bg, #fff);
    color: var(--color-text, #111827);
    cursor: pointer;
    line-height: 1;
  }
  .cg-iconbtn:hover:not(:disabled) {
    background: var(--color-surface-hover, #f3f4f6);
  }
  .cg-iconbtn:disabled { opacity: 0.45; cursor: not-allowed; }
  .cg-iconbtn[aria-pressed="true"] {
    border-color: var(--color-primary, #7c3aed);
    color: var(--color-primary, #7c3aed);
    background: var(--color-primary-light, #ede9fe);
  }
  .cg-zoom-readout {
    font-size: var(--font-size-xs, 0.75rem);
    color: var(--color-text-secondary);
    min-width: 3ch;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  .cg-scope-filter, .cg-hops {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    font-size: var(--font-size-sm);
    color: var(--color-text-secondary);
  }
  .cg-status {
    padding: var(--spacing-md);
    color: var(--color-text-secondary);
  }
  .cg-error { color: var(--color-danger); }
  .cg-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--spacing-sm);
    padding: var(--spacing-xs) var(--spacing-sm);
    font-size: var(--font-size-sm);
    color: var(--color-text-secondary);
    background: var(--color-warning-bg, #fef3c7);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
  }
  .cg-body {
    display: grid;
    grid-template-columns: minmax(0, 2fr) minmax(220px, 1fr);
    gap: var(--spacing-md);
    align-items: start;
  }
  .cg-canvas-wrap { position: relative; min-width: 0; }
  .cg-canvas {
    width: 100%;
    height: auto;
    display: block;
    background: var(--color-surface-soft, #f9fafb);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md, 8px);
    touch-action: none;
    cursor: grab;
  }
  .cg-canvas.cg-panning { cursor: grabbing; }
  .cg-canvas:focus { outline: none; }
  .cg-canvas:focus-visible {
    outline: 2px solid var(--color-focus-ring, var(--color-primary, #7c3aed));
    outline-offset: 2px;
  }
  .cg-sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  .cg-focus-pill {
    position: absolute;
    top: var(--spacing-sm);
    left: var(--spacing-sm);
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.2rem 0.5rem;
    font-size: var(--font-size-xs, 0.75rem);
    background: var(--color-bg, #fff);
    border: 1px solid var(--color-primary, #7c3aed);
    color: var(--color-primary, #7c3aed);
    border-radius: var(--radius-button, 9999px);
  }
  .cg-focus-pill button {
    border: none;
    background: none;
    color: inherit;
    cursor: pointer;
    font-size: 1rem;
    line-height: 1;
    padding: 0;
  }
  .cg-edge { transition: opacity var(--transition-fast, 150ms ease); }
  .cg-node { cursor: pointer; }
  .cg-node-hit { fill: transparent; }
  .cg-node circle.cg-node-dot {
    transition: fill-opacity var(--transition-fast, 150ms ease);
  }
  .cg-node:focus { outline: none; }
  /* Roving-tabindex keyboard focus ring: a dashed halo around the node,
     using the focus-ring token so it is visually distinct from both the
     solid selected stroke and the hover highlight. Shown only for
     keyboard focus (:focus-visible), not pointer selection. */
  .cg-node-focusring {
    fill: none;
    stroke: none;
    pointer-events: none;
  }
  .cg-node:focus-visible .cg-node-focusring {
    stroke: var(--color-focus-ring, var(--color-primary, #7c3aed));
    stroke-width: 2.5;
    stroke-dasharray: 3 2.5;
  }
  .cg-node-label {
    font-size: 11px;
    fill: var(--color-text, #111827);
    pointer-events: none;
    paint-order: stroke;
    stroke: var(--color-surface-soft, #f9fafb);
    stroke-width: 3px;
    stroke-linejoin: round;
  }
  .cg-edge-label {
    font-size: 9px;
    opacity: 0.95;
    pointer-events: none;
    /* Halo so a label stays legible where it crosses other edges. */
    paint-order: stroke;
    stroke: var(--color-surface-soft, #f9fafb);
    stroke-width: 3px;
    stroke-linejoin: round;
  }
  .cg-dim { opacity: 0.12; }
  .cg-detail {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md, 8px);
    padding: var(--spacing-md);
    background: var(--color-surface, #fff);
    overflow-y: auto;
  }
  .cg-detail-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--spacing-sm);
  }
  .cg-detail-title { margin: 0; font-size: var(--font-size-md, 1rem); }
  .cg-detail-actions {
    margin: var(--spacing-sm) 0 0;
    display: flex;
    gap: var(--spacing-xs);
    flex-wrap: wrap;
  }
  .cg-detail-meta {
    margin: 0.25rem 0 var(--spacing-sm);
    font-size: var(--font-size-sm);
    color: var(--color-text-secondary);
  }
  .cg-detail-section { margin-top: var(--spacing-md); }
  .cg-detail-subhead {
    margin: 0 0 0.375rem;
    font-size: var(--font-size-sm);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-text-secondary);
  }
  .cg-detail-empty {
    margin: 0;
    font-size: var(--font-size-sm);
    color: var(--color-text-secondary);
  }
  .cg-detail-list, .cg-evidence-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    font-size: var(--font-size-sm);
  }
  .cg-detail-list li {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .cg-rel-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex: 0 0 auto;
  }
  .cg-evidence-item {
    border-left: 2px solid var(--color-border);
    padding-left: var(--spacing-sm);
  }
  .cg-evidence-content { margin: 0; }
  .cg-evidence-cite {
    margin: 0.2rem 0 0;
    font-size: var(--font-size-xs, 0.75rem);
    color: var(--color-text-secondary);
  }
  .cg-legends {
    display: flex;
    flex-wrap: wrap;
    gap: var(--spacing-md);
  }
  .cg-legend {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--spacing-sm);
    font-size: var(--font-size-sm);
    color: var(--color-text-secondary);
  }
  .cg-legend-caption {
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-size: var(--font-size-xs, 0.75rem);
  }
  .cg-legend-item {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.1rem 0.4rem;
    border: 1px solid transparent;
    border-radius: var(--radius-sm, 6px);
    background: none;
    color: inherit;
    cursor: pointer;
    font-size: inherit;
  }
  .cg-legend-item:hover { background: var(--color-surface-hover, #f3f4f6); }
  .cg-legend-item[aria-pressed="false"] {
    opacity: 0.45;
    text-decoration: line-through;
  }
  .cg-legend-swatch {
    width: 12px;
    height: 3px;
    border-radius: 2px;
    flex: 0 0 auto;
  }
  .cg-legend-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex: 0 0 auto;
  }
  .cg-legend-trunc { font-style: italic; }
  /* Canvas (large-graph) renderer surface — same box as the SVG canvas. */
  .cg-canvas-gl {
    width: 100%;
    height: auto;
    display: block;
    background: var(--color-surface-soft, #f9fafb);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md, 8px);
    touch-action: none;
    cursor: grab;
  }
  .cg-canvas-gl.cg-panning { cursor: grabbing; }
  .cg-canvas-gl:focus { outline: none; }
  .cg-canvas-gl:focus-visible {
    outline: 2px solid var(--color-focus-ring, var(--color-primary, #7c3aed));
    outline-offset: 2px;
  }
  /* Saved-view preset controls. */
  .cg-preset-group { flex-wrap: wrap; }
  .cg-preset-name { width: 9rem; max-width: 40vw; }
  .cg-preset-pick .input { max-width: 11rem; }
  /* Decay overlay: time scrubber + recency legend. */
  .cg-decay-controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--spacing-md);
    padding: var(--spacing-xs) var(--spacing-sm);
    font-size: var(--font-size-sm);
    color: var(--color-text-secondary);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-soft, #f9fafb);
  }
  .cg-decay-scrubber {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm);
    flex: 1 1 16rem;
    min-width: 12rem;
  }
  .cg-decay-scrubber input[type="range"] { flex: 1 1 auto; min-width: 6rem; }
  .cg-decay-time {
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .cg-decay-legend {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm);
  }
  .cg-decay-ramp {
    display: inline-flex;
    height: 10px;
    width: 140px;
    border-radius: 9999px;
    overflow: hidden;
    border: 1px solid var(--color-border);
  }
  .cg-decay-ramp span { flex: 1 1 auto; }
  @media (max-width: 720px) {
    .cg-body { grid-template-columns: 1fr; }
  }
  @media (prefers-reduced-motion: reduce) {
    .cg-edge, .cg-node circle.cg-node-dot { transition: none; }
  }
`;

/** Format a unix-seconds instant as a short, locale-aware date label. */
function formatDay(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

interface DecayControlsProps {
  bounds: TimeBounds;
  asOf: number | null;
  onScrub: (value: number | null) => void;
  scheme: "light" | "dark";
}

/**
 * Time scrubber + recency legend for the decay overlay. Thin presentational
 * shell: the ramp colors come from {@link decayLegendStops} and the "as of"
 * filtering lives in the panel. With no temporal data it degrades to a
 * static legend (the scrubber would have nothing to move over).
 */
function DecayControls({ bounds, asOf, onScrub, scheme }: DecayControlsProps) {
  const stops = decayLegendStops(scheme);
  const hasRange =
    bounds.min !== null && bounds.max !== null && bounds.max > bounds.min;
  const ramp = (
    <span className="cg-decay-legend" data-testid="concept-graph-decay-legend">
      <span className="cg-legend-caption">Older</span>
      <span className="cg-decay-ramp" aria-hidden="true">
        {stops.map((s) => (
          <span key={s.t} style={{ background: s.color }} />
        ))}
      </span>
      <span className="cg-legend-caption">Recent</span>
    </span>
  );

  if (!hasRange || bounds.min === null || bounds.max === null) {
    return (
      <div className="cg-decay-controls" data-testid="concept-graph-decay-controls">
        <span>Recency overlay (no dated memories for these concepts).</span>
        {ramp}
      </div>
    );
  }

  // Local copies so the change handler's closure keeps the narrowed
  // non-null types (TS doesn't carry control-flow narrowing into callbacks).
  const min = bounds.min;
  const max = bounds.max;
  const value = asOf ?? max;
  const step = Math.max(1, Math.round((max - min) / 200));
  return (
    <div className="cg-decay-controls" data-testid="concept-graph-decay-controls">
      <label className="cg-decay-scrubber">
        <span className="cg-sr-only">Show graph as of date</span>
        <span className="cg-decay-time" aria-hidden="true">
          {formatDay(min)}
        </span>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          data-testid="concept-graph-decay-scrubber"
          aria-label={`Show concept graph as of ${formatDay(value)}`}
          aria-valuetext={formatDay(value)}
          onChange={(e) => {
            const next = Number(e.target.value);
            onScrub(next >= max ? null : next);
          }}
        />
        <span className="cg-decay-time" aria-hidden="true">
          {formatDay(max)}
        </span>
      </label>
      <span className="cg-decay-time" data-testid="concept-graph-decay-asof">
        As of {asOf === null ? "now" : formatDay(asOf)}
      </span>
      {asOf !== null && (
        <button
          type="button"
          className="cg-iconbtn"
          data-testid="concept-graph-decay-now"
          onClick={() => onScrub(null)}
        >
          Now
        </button>
      )}
      {ramp}
    </div>
  );
}

export default function ConceptGraphPanel({
  scope = null,
  maxNodes = 120,
  memories = [],
  height = 460,
  title,
  "data-testid": dataTestId,
}: ConceptGraphPanelProps) {
  const cspNonce = useCspNonce();
  const markerPrefix = useId();
  const prefersReducedMotion = usePrefersReducedMotion();

  const [nodeCap, setNodeCap] = useState(maxNodes);
  // A new `maxNodes` prop resets the locally-expanded cap.
  useEffect(() => setNodeCap(maxNodes), [maxNodes]);

  const { graph, loading, error, refresh } = useConceptGraph(scope, nodeCap);

  // ----- persisted view state (per scope) -----
  // The localStorage namespace for this panel's view controls. A null
  // scope (the default scope) gets a stable sentinel key so it persists
  // too without colliding with a real scope id.
  const scopeKey = scope ?? "__default__";
  // Loaded once at mount for the initial scope; scope *changes* are
  // re-applied by an effect below. Falls back to defaults if absent or
  // corrupt (loadViewState never throws).
  const initialViewState = useRef(loadViewState(scopeKey) ?? defaultViewState());

  const [scopeFilter, setScopeFilter] = useState<string>(
    () => initialViewState.current.scopeFilter,
  );
  const [selectedId, setSelectedId] = useState<string | null>(
    () => initialViewState.current.selectedId,
  );
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  // The single keyboard-focusable node (roving tabindex). Distinct from
  // selection and hover; arrow keys move it around the canvas.
  const [rovingId, setRovingId] = useState<string | null>(
    () => initialViewState.current.selectedId,
  );
  const [disabledRelations, setDisabledRelations] = useState<
    ReadonlySet<ConceptRelation>
  >(() => new Set(initialViewState.current.disabledRelations));
  const [disabledStates, setDisabledStates] = useState<
    ReadonlySet<ConceptNodeState>
  >(() => new Set(initialViewState.current.disabledStates));
  const [localMode, setLocalMode] = useState(
    () => initialViewState.current.localMode,
  );
  const [localHops, setLocalHops] = useState(
    () => initialViewState.current.localHops,
  );
  const [labelsAll, setLabelsAll] = useState(
    () => initialViewState.current.labelsAll,
  );
  // Time-based decay overlay: color/size/opacity by concept recency, with
  // an optional "as of" scrubber. Off by default so the baseline render is
  // unchanged. `asOf` is a unix-seconds instant or null = "now" (graph max).
  const [decayMode, setDecayMode] = useState(false);
  const [asOf, setAsOf] = useState<number | null>(null);
  // Debounced screen-reader announcement (selection + local-graph state).
  const [announcement, setAnnouncement] = useState("");

  // Active color scheme for the decay ramp (data-theme override, else the
  // OS preference). Tokens.css drives the rest of the palette; the decay
  // colors are computed in JS so they need the resolved scheme.
  const [scheme, setScheme] = useState<"light" | "dark">(detectColorScheme);
  useEffect(() => {
    const update = () => setScheme(detectColorScheme());
    const root = document.documentElement;
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    const mq =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-color-scheme: dark)")
        : null;
    mq?.addEventListener?.("change", update);
    return () => {
      observer.disconnect();
      mq?.removeEventListener?.("change", update);
    };
  }, []);

  // ----- saved filter presets (per scope, separate storage key) -----
  const [presetStore, setPresetStore] = useState<ConceptGraphPresetStore>(() =>
    loadPresetStore(scope ?? "__default__"),
  );
  const [presetName, setPresetName] = useState("");
  // The scope the currently-held `presetStore` was loaded for. The store is
  // replaced via async `setState` on scope change, so persistence keys off
  // this ref (the store's true owner) rather than the live `scopeKey`.
  const presetStoreScopeRef = useRef(scopeKey);

  // ----- scope filtering (preserved from the prior implementation) -----
  const scopes = useMemo(() => {
    const set = new Set<string>();
    for (const n of graph.nodes) set.add(n.scopeId);
    return [...set].sort();
  }, [graph.nodes]);

  const effectiveScopeFilter =
    scopeFilter !== "all" && scopes.includes(scopeFilter) ? scopeFilter : "all";

  useEffect(() => {
    if (scopeFilter !== "all" && !scopes.includes(scopeFilter)) {
      setScopeFilter("all");
      setSelectedId(null);
    }
  }, [scopes, scopeFilter]);

  const scopedView: ConceptGraphView = useMemo(() => {
    if (effectiveScopeFilter === "all") return graph;
    const nodes = graph.nodes.filter((n) => n.scopeId === effectiveScopeFilter);
    const ids = new Set(nodes.map((n) => n.id));
    const edges = graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
    // Freeze like every other derived view (filter/local-graph) so the
    // deep-frozen invariant holds uniformly for all views in the component.
    return freezeView({ ...graph, nodes, edges });
  }, [graph, effectiveScopeFilter]);

  // ----- which relation types / node kinds exist (for legend + filters) -----
  const relationsPresent = useMemo(() => {
    const set = new Set<ConceptRelation>();
    for (const e of scopedView.edges) set.add(e.relationType);
    return [...set];
  }, [scopedView.edges]);

  const statesPresent = useMemo(() => {
    const set = new Set<ConceptNodeState>();
    for (const n of scopedView.nodes) set.add(n.state);
    return [...set];
  }, [scopedView.nodes]);

  // ----- apply relation/kind filters, then optional local-graph scoping -----
  const filteredView = useMemo(() => {
    const relations =
      disabledRelations.size > 0
        ? new Set(relationsPresent.filter((r) => !disabledRelations.has(r)))
        : undefined;
    const states =
      disabledStates.size > 0
        ? new Set(statesPresent.filter((s) => !disabledStates.has(s)))
        : undefined;
    return filterGraphView(scopedView, { relations, states });
  }, [
    scopedView,
    disabledRelations,
    disabledStates,
    relationsPresent,
    statesPresent,
  ]);

  const view = useMemo(() => {
    if (localMode && selectedId) {
      return localGraphView(filteredView, selectedId, localHops);
    }
    return filteredView;
  }, [filteredView, localMode, selectedId, localHops]);

  // Order-independent fingerprint of the visible node set. Used to decide
  // whether a persisted viewBox still applies on restore (re-fit if the
  // node set has changed) — see the fit effect below.
  const viewSignature = useMemo(
    () => computeViewSignature(view.nodes.map((n) => n.id)),
    [view.nodes],
  );

  // ===== time-based decay model (driven by real substrate fields) =====
  // Correlate each visible concept to its mentioning memories and aggregate
  // their real timestamps / retention / lifecycle state. Built only while
  // the overlay is on so the baseline render pays nothing. Bounded by the
  // visible node set × memories.
  const decayMap = useMemo(
    () =>
      decayMode
        ? buildConceptDecayMap(view.nodes, memories)
        : new Map<string, ConceptDecay>(),
    [decayMode, view.nodes, memories],
  );
  const timeBounds = useMemo(() => computeTimeBounds(decayMap), [decayMap]);
  // The scrubber instant: an explicit `asOf`, else "now" (the latest known
  // access across the graph). null bounds → no temporal data at all.
  const decayNow = asOf ?? timeBounds.max;
  // Whether the scrubber is rewound before the newest instant (so the
  // "as of" filter actually hides not-yet-present concepts).
  const scrubbing =
    decayMode &&
    asOf !== null &&
    timeBounds.max !== null &&
    asOf < timeBounds.max;

  // Concepts not yet present as of the scrubber instant — hidden (not
  // re-laid-out) so the graph appears to grow over time without churning
  // positions on every scrub tick.
  const asOfHidden = useMemo(() => {
    const set = new Set<string>();
    if (!scrubbing || decayNow === null) return set;
    for (const node of view.nodes) {
      const d = decayMap.get(node.id);
      if (d && !isPresentAsOf(d, decayNow)) set.add(node.id);
    }
    return set;
  }, [scrubbing, decayNow, view.nodes, decayMap]);

  // Resolve a node's decay-driven visual style. `null` recency = timeless
  // (no memory time data) → neutral. Pure lookups; memoized indirectly via
  // its inputs through the callers' own memos.
  const decayStyleOf = useCallback(
    (state: ConceptNodeState, id: string): CanvasNodeStyle => {
      if (!decayMode) {
        return { fill: STATE_CANVAS_COLORS[state], alpha: 1, sizeFactor: 1 };
      }
      const d = decayMap.get(id);
      const t =
        d && decayNow !== null ? recencyFraction(d, decayNow, timeBounds) : null;
      return {
        fill: decayColor(t, scheme),
        alpha: decayOpacity(t),
        sizeFactor: decaySizeFactor(t),
      };
    },
    [decayMode, decayMap, decayNow, timeBounds, scheme],
  );

  // Restore-time invariant: a persisted `selectedId` that no longer exists
  // in the freshly-loaded graph must not strand the user in an empty local
  // graph (mirrors the scope-filter fix). The check runs against the *full*
  // graph (not the filtered view) so a node merely hidden by a legend
  // filter keeps its selection. Empty graph (initial load) is skipped so a
  // restored selection isn't cleared before data arrives.
  useEffect(() => {
    if (!selectedId || graph.nodes.length === 0) return;
    if (graph.nodes.some((n) => n.id === selectedId)) return;
    setSelectedId(null);
    setLocalMode(false);
  }, [graph.nodes, selectedId]);

  const layout = useMemo(
    () => computeForceLayout(view, { width: CANVAS_WIDTH, height }),
    [view, height],
  );

  const baseFit = useMemo<FitBox>(() => computeFitBox(layout), [layout]);
  const degrees = useMemo(() => computeDegrees(view), [view]);
  const maxDegree = useMemo(
    () => [...degrees.values()].reduce((m, d) => Math.max(m, d), 0),
    [degrees],
  );

  // Paint order: SVG draws in document order (later = on top). `layout.nodes`
  // is most-connected-first, which would paint high-degree hubs *underneath*
  // smaller leaves where they overlap. Render smallest-radius first so the
  // larger hub nodes sit on top — the visual hierarchy users expect.
  const paintNodes = useMemo(
    () => [...layout.nodes].sort((a, b) => a.radius - b.radius),
    [layout.nodes],
  );

  // ===== settle animation: tween display positions toward the layout =====
  const displayRef = useRef<Map<string, Point>>(new Map());
  const [displayPos, setDisplayPos] = useState<Map<string, Point>>(new Map());
  const commitDisplay = useCallback((next: Map<string, Point>) => {
    displayRef.current = next;
    setDisplayPos(next);
  }, []);

  const [dragPos, setDragPos] = useState<Map<string, Point>>(new Map());
  // Mirror drag overrides into a ref so event callbacks can read the live
  // map without taking `dragPos` as a dependency (which would otherwise
  // recreate those callbacks — and re-prop every node — on every drag frame).
  const dragPosRef = useRef<Map<string, Point>>(dragPos);
  const commitDragPos = useCallback((next: Map<string, Point>) => {
    dragPosRef.current = next;
    setDragPos(next);
  }, []);
  // Drag overrides are stale once the layout (data/filter/size) changes.
  useEffect(() => commitDragPos(new Map()), [layout, commitDragPos]);

  // A layout effect (not a passive effect) so the starting frame is committed
  // *before* the browser paints. With a passive effect the browser would paint
  // one frame using `renderPos`'s `{ x: n.x, y: n.y }` fallback — i.e. the final
  // layout positions — before the first rAF tick moved nodes to the center,
  // producing a visible flash that contradicts the "grow from center" intent.
  useLayoutEffect(() => {
    const targets = layout.nodes;
    const animate =
      !prefersReducedMotion &&
      typeof requestAnimationFrame === "function" &&
      targets.length > 0;

    if (!animate) {
      const snapped = new Map<string, Point>();
      for (const n of targets) snapped.set(n.id, { x: n.x, y: n.y });
      commitDisplay(snapped);
      return;
    }

    const from = displayRef.current;
    const start = new Map<string, Point>();
    for (const n of targets) {
      // New nodes grow out of the canvas center; existing nodes ease from
      // wherever they currently are (so re-layouts feel continuous).
      start.set(
        n.id,
        from.get(n.id) ?? { x: layout.width / 2, y: layout.height / 2 },
      );
    }
    // Commit the start frame synchronously, before paint, so the first painted
    // frame shows nodes at their easing origin rather than their destination.
    commitDisplay(start);

    const DURATION = 650;
    const begin = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - begin) / DURATION);
      const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
      const next = new Map<string, Point>();
      for (const n of targets) {
        const s = start.get(n.id)!;
        next.set(n.id, {
          x: s.x + (n.x - s.x) * eased,
          y: s.y + (n.y - s.y) * eased,
        });
      }
      commitDisplay(next);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [layout, prefersReducedMotion, commitDisplay]);

  // ===== pan / zoom (SVG viewBox) =====
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [viewBox, setViewBox] = useState<FitBox>(baseFit);
  const viewBoxRef = useRef<FitBox>(baseFit);
  // Mirror baseFit into a ref so zoom math can read the current fit width
  // without taking it as a dependency — otherwise zoomAround (and the
  // non-passive wheel listener that closes over it) would be recreated and
  // the listener re-attached on every layout/filter change.
  const baseFitRef = useRef<FitBox>(baseFit);
  const applyViewBox = useCallback((box: FitBox) => {
    viewBoxRef.current = box;
    setViewBox(box);
  }, []);
  // A persisted viewBox waiting to be re-applied once the matching node set
  // is on screen. Consumed at most once (cleared after the first fit pass),
  // so subsequent layout changes re-fit normally.
  const pendingRestoreRef = useRef<{ box: FitBox; signature: number } | null>(
    initialViewState.current.viewBox
      ? {
          box: initialViewState.current.viewBox,
          signature: initialViewState.current.viewSignature,
        }
      : null,
  );
  // Fit-on-load and re-fit whenever the layout changes (new data / filter),
  // except: if a persisted viewBox is pending and the visible node set still
  // matches the one it was saved against, restore that pan/zoom instead of
  // re-fitting. A pending restore whose signature no longer matches (the
  // graph changed since last session) is dropped in favour of a fresh fit.
  useEffect(() => {
    baseFitRef.current = baseFit;
    const pending = pendingRestoreRef.current;
    if (pending && viewSignature !== 0) {
      pendingRestoreRef.current = null;
      if (pending.signature === viewSignature) {
        viewBoxRef.current = pending.box;
        setViewBox(pending.box);
        return;
      }
    }
    viewBoxRef.current = baseFit;
    setViewBox(baseFit);
  }, [baseFit, viewSignature]);

  const zoomAround = useCallback(
    (px: number, py: number, factor: number) => {
      const vb = viewBoxRef.current;
      const base = baseFitRef.current.width;
      const minW = base / MAX_ZOOM;
      const maxW = base / MIN_ZOOM;
      const targetW = vb.width * factor;
      const nw = Math.min(maxW, Math.max(minW, targetW));
      if (nw === vb.width) return;
      const scale = nw / vb.width;
      const nh = vb.height * scale;
      const worldX = vb.x + px * vb.width;
      const worldY = vb.y + py * vb.height;
      applyViewBox({
        x: worldX - px * nw,
        y: worldY - py * nh,
        width: nw,
        height: nh,
      });
    },
    [applyViewBox],
  );

  // Non-passive wheel listener (so we can preventDefault the page scroll),
  // bound via a callback ref rather than an effect. The <svg> is conditionally
  // rendered — it does not exist during the initial loading paint — and an
  // effect keyed on the (stable) zoomAround would run once on mount, find
  // svgRef.current null, and never re-run, leaving wheel-zoom permanently
  // unbound. A callback ref instead ties the listener's lifecycle to the
  // element's: it attaches exactly when the SVG mounts and detaches on
  // unmount, with no per-layout re-attach churn (zoomAround is stable).
  const wheelCleanupRef = useRef<(() => void) | null>(null);
  const attachSvg = useCallback(
    (el: SVGSVGElement | null) => {
      svgRef.current = el;
      if (wheelCleanupRef.current) {
        wheelCleanupRef.current();
        wheelCleanupRef.current = null;
      }
      if (!el) return;
      const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const px = (e.clientX - rect.left) / rect.width;
        const py = (e.clientY - rect.top) / rect.height;
        // Scroll up (deltaY < 0) zooms in → smaller viewBox.
        const factor = Math.exp((e.deltaY > 0 ? 1 : -1) * 0.14);
        zoomAround(px, py, factor);
      };
      el.addEventListener("wheel", onWheel, { passive: false });
      wheelCleanupRef.current = () => el.removeEventListener("wheel", onWheel);
    },
    [zoomAround],
  );

  const fitToView = useCallback(() => applyViewBox(baseFit), [applyViewBox, baseFit]);
  const zoomByButton = useCallback(
    (factor: number) => zoomAround(0.5, 0.5, factor),
    [zoomAround],
  );

  const resetView = useCallback(() => {
    setSelectedId(null);
    setHoveredId(null);
    setLocalMode(false);
    setDisabledRelations(new Set());
    setDisabledStates(new Set());
    commitDragPos(new Map());
    applyViewBox(baseFit);
  }, [applyViewBox, baseFit, commitDragPos]);

  // Pan the canvas by a world-space delta (used by arrow keys when the SVG
  // itself is focused). Instant — no tween — so it honours reduced motion.
  const panBy = useCallback(
    (dx: number, dy: number) => {
      const vb = viewBoxRef.current;
      applyViewBox({ x: vb.x + dx, y: vb.y + dy, width: vb.width, height: vb.height });
    },
    [applyViewBox],
  );

  // ===== keyboard navigation (roving tabindex + canvas controls) =====
  const nodesGroupRef = useRef<SVGGElement | null>(null);
  // Live snapshot of the data the node key handler needs, so the handler
  // itself can stay referentially stable (empty deps) and not re-prop every
  // node on each layout/selection change.
  const navRef = useRef({ nodes: layout.nodes, view, degrees, localMode });
  navRef.current = { nodes: layout.nodes, view, degrees, localMode };

  // Move DOM focus to a node's <g> by id. Querying the group (rather than
  // holding 600 per-node refs) keeps the node render cheap; focus() works
  // even while the element still has tabIndex -1, before the roving state
  // commits. The id is escaped for use inside the attribute selector.
  const focusNodeEl = useCallback((id: string) => {
    const group = nodesGroupRef.current;
    if (!group) return;
    const selector = `[data-cg-node="${id.replace(/(["\\])/g, "\\$1")}"]`;
    const el = group.querySelector<SVGGElement>(selector);
    el?.focus();
  }, []);

  const onNodeKeyDown = useCallback(
    (e: ReactKeyboardEvent<SVGGElement>, nodeId: string) => {
      const { nodes, view: navView, degrees: navDegrees, localMode: navLocal } =
        navRef.current;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        setSelectedId(nodeId);
        setRovingId(nodeId);
        return;
      }
      const direction = ARROW_DIRECTIONS[e.key];
      if (direction) {
        e.preventDefault();
        e.stopPropagation();
        const next = findNeighborInDirection(nodes, nodeId, direction);
        if (next) {
          setRovingId(next);
          focusNodeEl(next);
        }
        return;
      }
      if (e.key === "Home") {
        e.preventDefault();
        e.stopPropagation();
        const first = nodes[0]?.id ?? null;
        if (first) {
          setRovingId(first);
          focusNodeEl(first);
        }
        return;
      }
      if (e.key === "End") {
        e.preventDefault();
        e.stopPropagation();
        const hub = highestDegreeNodeId(navView, navDegrees);
        if (hub) {
          setRovingId(hub);
          focusNodeEl(hub);
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (navLocal) setLocalMode(false);
        else setSelectedId(null);
      }
    },
    [focusNodeEl],
  );

  // Canvas-level keys: only when the <svg> itself holds focus (not bubbled
  // up from a node, which handles its own keys and stops propagation).
  const onCanvasKeyDown = useCallback(
    (e: ReactKeyboardEvent<SVGSVGElement>) => {
      if (e.target !== e.currentTarget) return;
      const vb = viewBoxRef.current;
      switch (e.key) {
        case "ArrowUp":
          e.preventDefault();
          panBy(0, -vb.height * KEYBOARD_PAN_STEP);
          break;
        case "ArrowDown":
          e.preventDefault();
          panBy(0, vb.height * KEYBOARD_PAN_STEP);
          break;
        case "ArrowLeft":
          e.preventDefault();
          panBy(-vb.width * KEYBOARD_PAN_STEP, 0);
          break;
        case "ArrowRight":
          e.preventDefault();
          panBy(vb.width * KEYBOARD_PAN_STEP, 0);
          break;
        case "+":
        case "=":
          e.preventDefault();
          zoomByButton(0.8);
          break;
        case "-":
        case "_":
          e.preventDefault();
          zoomByButton(1 / 0.8);
          break;
        case "0":
        case "f":
        case "F":
          e.preventDefault();
          fitToView();
          break;
      }
    },
    [panBy, zoomByButton, fitToView],
  );

  // ===== debounced screen-reader announcements =====
  // A single debounced live-region message so rapid changes (e.g. holding
  // an arrow key, or toggling local mode quickly) coalesce into one
  // announcement instead of flooding the screen reader.
  const announceTimerRef = useRef<number | null>(null);
  const announce = useCallback((message: string) => {
    if (announceTimerRef.current !== null) {
      window.clearTimeout(announceTimerRef.current);
    }
    announceTimerRef.current = window.setTimeout(() => {
      announceTimerRef.current = null;
      setAnnouncement(message);
    }, ANNOUNCE_DEBOUNCE_MS);
  }, []);
  useEffect(
    () => () => {
      if (announceTimerRef.current !== null) {
        window.clearTimeout(announceTimerRef.current);
      }
    },
    [],
  );

  // Announce selection changes. Seeded with the restored selection so a
  // persisted selection isn't re-announced on mount (it wasn't a user act).
  const prevSelectedRef = useRef<string | null>(initialViewState.current.selectedId);
  useEffect(() => {
    if (selectedId === prevSelectedRef.current) return;
    prevSelectedRef.current = selectedId;
    if (!selectedId) {
      announce("Selection cleared");
      return;
    }
    const node = graph.nodes.find((n) => n.id === selectedId);
    if (!node) return;
    const n = node.connectionsCount;
    announce(`Selected ${node.label}, ${n} connection${n === 1 ? "" : "s"}`);
  }, [selectedId, graph.nodes, announce]);

  // Announce local-graph entry / hop-distance change / exit.
  const prevLocalRef = useRef({
    mode: initialViewState.current.localMode,
    hops: initialViewState.current.localHops,
  });
  useEffect(() => {
    const prev = prevLocalRef.current;
    if (prev.mode === localMode && prev.hops === localHops) return;
    prevLocalRef.current = { mode: localMode, hops: localHops };
    if (!localMode) {
      if (prev.mode) announce("Exited local graph");
      return;
    }
    const node = selectedId
      ? graph.nodes.find((n) => n.id === selectedId)
      : null;
    if (!node) return;
    const n = view.nodes.length;
    announce(
      `Local graph: ${node.label}, ${localHops}-hop, showing ${n} concept${
        n === 1 ? "" : "s"
      }`,
    );
  }, [localMode, localHops, selectedId, graph.nodes, view.nodes.length, announce]);

  // ===== persistence: re-apply on scope change + debounced save =====
  // A render-synchronous mirror of the serializable view state, so both the
  // debounced save and the synchronous scope-change flush write the same,
  // always-current snapshot without duplicating the field list.
  const liveStateRef = useRef<ConceptGraphViewState>(initialViewState.current);
  liveStateRef.current = {
    disabledRelations: [...disabledRelations],
    disabledStates: [...disabledStates],
    labelsAll,
    localMode,
    localHops,
    selectedId,
    scopeFilter,
    viewBox,
    viewSignature,
  };
  const scopeKeyRef = useRef(scopeKey);
  scopeKeyRef.current = scopeKey;

  // Flush the latest state on unmount: the debounced save effect's cleanup
  // only cancels its timer, so a change made within the debounce window
  // before the panel is torn down (e.g. toggling a filter then navigating
  // away) would otherwise be lost. Reads refs so the cleanup captures the
  // final scope + state rather than a stale closure.
  useEffect(
    () => () => {
      saveViewState(scopeKeyRef.current, liveStateRef.current);
    },
    [],
  );

  // Apply a preset's captured filter to the live controls. Selection is
  // preserved (a now-hidden selection is handled by existing invariants);
  // the viewBox re-fits via the layout-change effect. Declared before the
  // scope-change effect so that effect can apply a new scope's default inline.
  const applyPreset = useCallback((preset: ConceptGraphPreset) => {
    setDisabledRelations(new Set(preset.disabledRelations));
    setDisabledStates(new Set(preset.disabledStates));
    setScopeFilter(preset.scopeFilter);
    setLocalMode(preset.localMode);
    setLocalHops(preset.localHops);
    setLabelsAll(preset.labelsAll);
    setDecayMode(preset.decayMode);
    // The scrubber instant is ephemeral (tied to the live time bounds) and is
    // not captured by presets, so snap back to "now" — otherwise applying a
    // preset while scrubbed would re-enter decay at the stale instant.
    setAsOf(null);
  }, []);

  // Scope *changes* on an already-mounted panel reload that scope's saved
  // view state (the initial scope was applied via lazy state initialisers).
  const appliedScopeRef = useRef(scopeKey);
  useEffect(() => {
    const prevScope = appliedScopeRef.current;
    if (prevScope === scopeKey) return;
    // Flush the outgoing scope's latest state synchronously. The debounced
    // save effect's cleanup cancels its pending timer on this same render, so
    // a change made within the debounce window would otherwise be dropped
    // when the scope switches. liveStateRef still holds the old scope's values
    // here (the state resets below haven't committed yet).
    saveViewState(prevScope, liveStateRef.current);
    appliedScopeRef.current = scopeKey;
    const next = loadViewState(scopeKey) ?? defaultViewState();
    setScopeFilter(next.scopeFilter);
    setSelectedId(next.selectedId);
    setRovingId(next.selectedId);
    setDisabledRelations(new Set(next.disabledRelations));
    setDisabledStates(new Set(next.disabledStates));
    setLabelsAll(next.labelsAll);
    setLocalMode(next.localMode);
    setLocalHops(next.localHops);
    prevSelectedRef.current = next.selectedId;
    prevLocalRef.current = { mode: next.localMode, hops: next.localHops };
    pendingRestoreRef.current = next.viewBox
      ? { box: next.viewBox, signature: next.viewSignature }
      : null;
    // Reset the time-decay controls: the scrubber's "as of" instant is keyed
    // to the previous scope's time bounds so it must not carry over, and the
    // overlay returns to its off baseline (the new scope's default preset, if
    // any, turns it back on just below).
    setDecayMode(false);
    setAsOf(null);
    // Load the new scope's presets *synchronously* so its default can be
    // applied from the fresh store here. Keying the default-apply on the async
    // `presetStore` state instead would read the previous scope's store (the
    // `setPresetStore` below has not committed yet on this render).
    const nextStore = loadPresetStore(scopeKey);
    presetStoreScopeRef.current = scopeKey;
    setPresetStore(nextStore);
    setPresetName("");
    const def = findPreset(nextStore.presets, nextStore.defaultPresetId);
    if (def) applyPreset(def);
  }, [scopeKey, applyPreset]);

  // Debounced write of the (privacy-minimal) UI state. Only ids / enums /
  // numbers already present in the renderer are persisted — never source
  // content, evidence text, or concept labels.
  useEffect(() => {
    const handle = window.setTimeout(() => {
      saveViewState(scopeKey, liveStateRef.current);
    }, PERSIST_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [
    scopeKey,
    disabledRelations,
    disabledStates,
    labelsAll,
    localMode,
    localHops,
    selectedId,
    scopeFilter,
    viewBox,
    viewSignature,
  ]);

  // ===== saved filter presets =====
  // The live filter combination, compared against saved presets to surface
  // the active one and to capture on "save".
  const liveFilter: PresetFilter = useMemo(
    () => ({
      disabledRelations: [...disabledRelations],
      disabledStates: [...disabledStates],
      scopeFilter,
      localMode,
      localHops,
      labelsAll,
      decayMode,
    }),
    [
      disabledRelations,
      disabledStates,
      scopeFilter,
      localMode,
      localHops,
      labelsAll,
      decayMode,
    ],
  );
  // Id of the preset matching the live filter (highlighted in the picker),
  // or null when the user has diverged from every saved view.
  const currentPresetId = useMemo(
    () => activePresetId(presetStore.presets, liveFilter),
    [presetStore.presets, liveFilter],
  );

  // Persist the preset store (separate key from the view state). Written to
  // the scope the store was *loaded* for (`presetStoreScopeRef`), not the live
  // `scopeKey`, and keyed on the store value alone: during a scope switch the
  // `setPresetStore` in the scope-change effect is async, so keying on
  // `scopeKey` would briefly write the previous scope's presets under the new
  // scope's key (a crash in that window would corrupt it).
  useEffect(() => {
    savePresetStore(presetStoreScopeRef.current, presetStore);
  }, [presetStore]);

  // Apply the default preset on initial mount only; scope *changes* apply the
  // new scope's default inline in the scope-change effect (from the
  // synchronously loaded store). A ref guards against re-running on unrelated
  // re-renders.
  const appliedInitialDefaultRef = useRef(false);
  useEffect(() => {
    if (appliedInitialDefaultRef.current) return;
    appliedInitialDefaultRef.current = true;
    const def = findPreset(presetStore.presets, presetStore.defaultPresetId);
    if (def) applyPreset(def);
  }, [presetStore, applyPreset]);

  // Save the current filter under the entered name, updating the existing
  // preset with that name in place rather than appending a duplicate. Empty
  // names fall back to a placeholder.
  const saveCurrentPreset = useCallback(() => {
    setPresetStore((store) => ({
      ...store,
      presets: upsertPresetByName(store.presets, presetName, liveFilter),
    }));
    setPresetName("");
  }, [presetName, liveFilter]);

  const deletePreset = useCallback((id: string) => {
    setPresetStore((store) => ({
      presets: removePreset(store.presets, id),
      defaultPresetId:
        store.defaultPresetId === id ? null : store.defaultPresetId,
    }));
  }, []);

  const setDefaultPreset = useCallback((id: string | null) => {
    setPresetStore((store) => ({
      ...store,
      defaultPresetId: store.defaultPresetId === id ? null : id,
    }));
  }, []);

  // ===== pointer interactions: drag-to-pan + drag-node + click-to-select =====
  const panRef = useRef<{ x: number; y: number; box: FitBox } | null>(null);
  const dragNodeRef = useRef<{
    id: string;
    startX: number;
    startY: number;
    origin: Point;
    moved: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const [isPanning, setIsPanning] = useState(false);

  const onBackgroundPointerDown = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      // Node pointerdowns stopPropagation, so reaching here means the
      // background was grabbed → start a pan.
      panRef.current = { x: e.clientX, y: e.clientY, box: viewBoxRef.current };
      setIsPanning(true);
      svgRef.current?.setPointerCapture(e.pointerId);
    },
    [],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      const el = svgRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      const drag = dragNodeRef.current;
      if (drag) {
        const vb = viewBoxRef.current;
        const dx = ((e.clientX - drag.startX) / rect.width) * vb.width;
        const dy = ((e.clientY - drag.startY) / rect.height) * vb.height;
        if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 3) {
          drag.moved = true;
          suppressClickRef.current = true;
        }
        const nextPoint = { x: drag.origin.x + dx, y: drag.origin.y + dy };
        const next = new Map(dragPosRef.current);
        next.set(drag.id, nextPoint);
        commitDragPos(next);
        return;
      }

      const pan = panRef.current;
      if (pan) {
        const dx = ((e.clientX - pan.x) / rect.width) * pan.box.width;
        const dy = ((e.clientY - pan.y) / rect.height) * pan.box.height;
        applyViewBox({
          x: pan.box.x - dx,
          y: pan.box.y - dy,
          width: pan.box.width,
          height: pan.box.height,
        });
      }
    },
    [applyViewBox, commitDragPos],
  );

  const endPointer = useCallback((e: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragNodeRef.current;
    panRef.current = null;
    dragNodeRef.current = null;
    setIsPanning(false);
    if (svgRef.current?.hasPointerCapture(e.pointerId)) {
      svgRef.current.releasePointerCapture(e.pointerId);
    }
    // Selection happens on pointer-up rather than the synthetic `click`:
    // `onNodePointerDown` captures the pointer on the <svg>, which redirects
    // the compatibility click to the SVG (not the node <g>), so a node's
    // `onClick` never fires in a real browser. A tap that didn't drift past
    // the drag threshold is treated as a selection. Move the roving tabindex
    // onto the tapped node too, so keyboard focus follows pointer selection
    // (otherwise `effectiveRovingId` would keep tabIndex=0 on a stale node).
    if (drag && !drag.moved) {
      setSelectedId(drag.id);
      setRovingId(drag.id);
    }
  }, []);

  const onNodePointerDown = useCallback(
    (e: ReactPointerEvent<SVGGElement>, node: PositionedNode) => {
      e.stopPropagation();
      const current =
        dragPosRef.current.get(node.id) ??
        displayRef.current.get(node.id) ?? { x: node.x, y: node.y };
      dragNodeRef.current = {
        id: node.id,
        startX: e.clientX,
        startY: e.clientY,
        origin: current,
        moved: false,
      };
      svgRef.current?.setPointerCapture(e.pointerId);
    },
    [],
  );

  const onNodeClick = useCallback((id: string) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    setSelectedId(id);
  }, []);

  // ===== selection-derived detail data =====
  const selectedNode = useMemo(
    () => view.nodes.find((n) => n.id === selectedId) ?? null,
    [view.nodes, selectedId],
  );

  const selectedRelations = useMemo(() => {
    if (!selectedNode) return [];
    const labelOf = (id: string) =>
      view.nodes.find((n) => n.id === id)?.label ?? id;
    return view.edges
      .filter((e) => e.from === selectedNode.id || e.to === selectedNode.id)
      .map((e) => {
        const outgoing = e.from === selectedNode.id;
        return {
          id: e.id,
          relationType: e.relationType,
          direction: outgoing ? ("out" as const) : ("in" as const),
          otherLabel: labelOf(outgoing ? e.to : e.from),
        };
      });
  }, [selectedNode, view.edges, view.nodes]);

  const selectedEvidence = useMemo(() => {
    if (!selectedNode) return [];
    // Shared concept↔memory matcher (word-boundary aware) so the evidence
    // panel and the decay overlay correlate concepts to memories identically.
    // Compile the matcher once and reuse it across every memory.
    const mentions = conceptMentionMatcher(selectedNode.label);
    return memories.filter((m) => mentions(m.content)).slice(0, 8);
  }, [selectedNode, memories]);

  // ===== highlight/dim: focus = hovered node, else selected node =====
  const focusId = hoveredId ?? selectedId;
  const focus = useMemo(() => {
    if (!focusId) return null;
    const { nodeIds, edgeIds } = incidentTo(view, focusId);
    return nodeIds.size > 0 ? { nodeIds, edgeIds } : null;
  }, [view, focusId]);

  // ===== rendering helpers =====
  const renderPos = useMemo(() => {
    const map = new Map<string, Point>();
    for (const n of layout.nodes) {
      map.set(n.id, dragPos.get(n.id) ?? displayPos.get(n.id) ?? { x: n.x, y: n.y });
    }
    return map;
  }, [layout.nodes, dragPos, displayPos]);

  // Node radii by id, for self-loop sizing in the edge geometry.
  const radiusById = useMemo(() => {
    const map = new Map<string, number>();
    for (const n of layout.nodes) map.set(n.id, n.radius);
    return map;
  }, [layout.nodes]);

  // Per-edge curvature so reciprocal / parallel edges fan apart (pure math).
  const edgeCurves = useMemo(() => computeEdgeCurves(view.edges), [view.edges]);

  // SVG path + label anchor for every edge, derived from the live render
  // positions. Quadratic curves with a per-pair offset; self-loops become
  // little arcs above the node. Heavy geometry stays in the pure util.
  const edgeGeometry = useMemo(() => {
    const map = new Map<string, { d: string; labelPoint: Point }>();
    for (const edge of view.edges) {
      const from = renderPos.get(edge.from);
      const to = renderPos.get(edge.to);
      if (!from || !to) continue;
      const curve = edgeCurves.get(edge.id);
      if (curve?.selfLoop) {
        const r = radiusById.get(edge.from) ?? 14;
        const loopR = r + 10 + curve.loopIndex * 7;
        const top = from.y - r;
        map.set(edge.id, {
          d: `M ${from.x} ${top} C ${from.x - loopR} ${top - loopR * 1.6} ${
            from.x + loopR
          } ${top - loopR * 1.6} ${from.x} ${top}`,
          labelPoint: { x: from.x, y: top - loopR * 1.15 },
        });
        continue;
      }
      // Canonical endpoint order (by id) so every edge in a parallel group
      // shares one normal basis and the signed offsets land on predictable
      // sides; the path itself is still drawn from `from` → `to` so the
      // arrowhead points the right way. Uses the same `compareCodepoint`
      // ordering as `pairKey` in the layout util — single source of truth, so
      // the two can't silently diverge (e.g. if the comparison ever changed).
      const swap = compareCodepoint(edge.from, edge.to) > 0;
      const canonFrom = swap ? to : from;
      const canonTo = swap ? from : to;
      const control = quadraticControlPoint(canonFrom, canonTo, curve?.offset ?? 0);
      map.set(edge.id, quadraticEdgePath(from, to, control));
    }
    return map;
  }, [view.edges, renderPos, edgeCurves, radiusById]);

  const relationsUsed = useMemo(() => {
    const set = new Set<ConceptRelation>();
    for (const e of view.edges) set.add(e.relationType);
    return [...set];
  }, [view.edges]);

  const usedMarkerColors = useMemo(() => {
    const set = new Set<string>();
    for (const r of relationsUsed) set.add(RELATION_COLORS[r]);
    return [...set];
  }, [relationsUsed]);

  const markerId = (color: string) =>
    `${markerPrefix}-arrow-${color.replace(/[^a-zA-Z0-9]/g, "")}`;

  const zoom = baseFit.width > 0 ? baseFit.width / viewBox.width : 1;
  const nodeCount = layout.nodes.length;
  const showAllNodeLabels =
    labelsAll || nodeCount <= LABEL_ALL_THRESHOLD || zoom >= 1.3;
  const labelDegreeThreshold = Math.max(2, Math.ceil(maxDegree * 0.6));
  const labelVisible = (node: PositionedNode): boolean => {
    if (showAllNodeLabels) return true;
    if (focus?.nodeIds.has(node.id)) return true;
    return (degrees.get(node.id) ?? 0) >= labelDegreeThreshold;
  };
  const showEdgeLabels = view.edges.length <= EDGE_LABEL_THRESHOLD;

  // Which edge labels to actually draw, after greedy collision avoidance.
  // Candidates: every edge when below the wholesale threshold, otherwise
  // only the edges incident to the focused (hovered / selected / keyboard-
  // focused) node. Focused edges get priority so they win any overlap.
  const visibleEdgeLabelIds = useMemo(() => {
    const candidates: LabelCandidate[] = [];
    for (const edge of view.edges) {
      const isFocusEdge = focus ? focus.edgeIds.has(edge.id) : false;
      if (!showEdgeLabels && !isFocusEdge) continue;
      const geo = edgeGeometry.get(edge.id);
      if (!geo) continue;
      const text = RELATION_LABELS[edge.relationType];
      candidates.push({
        id: edge.id,
        x: geo.labelPoint.x,
        y: geo.labelPoint.y,
        width: text.length * EDGE_LABEL_CHAR_WIDTH + EDGE_LABEL_BOX_PADDING,
        height: EDGE_LABEL_BOX_HEIGHT,
        priority: isFocusEdge ? 0 : 1,
      });
    }
    return placeEdgeLabels(candidates);
  }, [view.edges, focus, showEdgeLabels, edgeGeometry]);

  // The single tab-focusable node (roving tabindex). Prefer the explicit
  // roving target, then the current selection, then the first (most-
  // connected) node — always falling back to one that still exists so the
  // tab order never points at a removed node. Nodes hidden by the time
  // scrubber (`asOfHidden`) are excluded so the roving target is always a
  // node that's actually painted: otherwise the Canvas (which receives the
  // `asOfHidden`-filtered node set) would try to navigate from / select a
  // node that isn't on screen, stalling arrow-key traversal.
  const effectiveRovingId = useMemo(() => {
    const visible = asOfHidden.size
      ? layout.nodes.filter((n) => !asOfHidden.has(n.id))
      : layout.nodes;
    const ids = new Set(visible.map((n) => n.id));
    if (rovingId && ids.has(rovingId)) return rovingId;
    if (selectedId && ids.has(selectedId)) return selectedId;
    return visible[0]?.id ?? null;
  }, [layout.nodes, rovingId, selectedId, asOfHidden]);

  // Renderer selection: switch to the Canvas surface once the node count
  // crosses the threshold where per-DOM-node cost starts to drop frames.
  const useCanvas = nodeCount >= CANVAS_RENDER_THRESHOLD;
  // Highest-degree node — the End-key target for both renderers.
  const hubId = useMemo(
    () => highestDegreeNodeId(view, degrees),
    [view, degrees],
  );

  // Node/edge sets fed to the canvas, with the as-of scrubber filter applied
  // (layout positions preserved; not-yet-present concepts simply omitted so
  // the graph appears to grow over time without re-laying-out on each tick).
  const canvasNodes = useMemo(
    () =>
      asOfHidden.size
        ? layout.nodes.filter((n) => !asOfHidden.has(n.id))
        : layout.nodes,
    [layout.nodes, asOfHidden],
  );
  const canvasEdges = useMemo(
    () =>
      asOfHidden.size
        ? view.edges.filter(
            (e) => !asOfHidden.has(e.from) && !asOfHidden.has(e.to),
          )
        : view.edges,
    [view.edges, asOfHidden],
  );
  const canvasStyleOf = useCallback(
    (node: PositionedNode): CanvasNodeStyle => decayStyleOf(node.state, node.id),
    [decayStyleOf],
  );

  // Canvas interaction callbacks (stable). Selection / hover / roving reuse
  // the panel's existing setters; node drag mirrors the SVG path's override.
  const dragNodeTo = useCallback(
    (id: string, world: Point) => {
      const next = new Map(dragPosRef.current);
      next.set(id, world);
      commitDragPos(next);
    },
    [commitDragPos],
  );
  const clearSelection = useCallback(() => setSelectedId(null), []);
  const exitLocal = useCallback(() => setLocalMode(false), []);

  const toggleRelation = (relation: ConceptRelation) => {
    setDisabledRelations((prev) => {
      const next = new Set(prev);
      if (next.has(relation)) next.delete(relation);
      else next.add(relation);
      return next;
    });
  };
  const toggleState = (state: ConceptNodeState) => {
    setDisabledStates((prev) => {
      const next = new Set(prev);
      if (next.has(state)) next.delete(state);
      else next.add(state);
      return next;
    });
  };

  const truncated = view.truncation !== "complete";
  const canShowMore = truncated && nodeCap < NODE_CAP_CEILING;

  return (
    <div data-testid={dataTestId ?? "concept-graph-panel"} className="cg-panel">
      <div className="cg-toolbar">
        {title ? <h3 className="cg-title">{title}</h3> : <span />}
        <div className="cg-toolbar-controls">
          {scopes.length > 1 && (
            <label className="cg-scope-filter">
              <span className="cg-scope-label">Scope</span>
              <select
                className="input"
                aria-label="Filter concept graph by scope"
                value={scopeFilter}
                onChange={(e) => {
                  setScopeFilter(e.target.value);
                  setSelectedId(null);
                }}
              >
                <option value="all">All scopes ({scopes.length})</option>
                {scopes.map((s) => (
                  <option key={s} value={s}>
                    {s.slice(0, 8)}…
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            type="button"
            className="btn btn-secondary cg-refresh"
            onClick={() => void refresh()}
          >
            Refresh
          </button>
        </div>
      </div>

      {loading ? (
        <p className="cg-status" aria-busy="true">
          Loading concept graph…
        </p>
      ) : error ? (
        <p className="cg-status cg-error" role="alert">
          {error}
        </p>
      ) : view.nodes.length === 0 ? (
        <p className="cg-status" data-testid="concept-graph-empty">
          {/* A non-empty `scopedView` collapsing to an empty `view` always
              means the legend filters hid every node — including, in local
              mode, the focus node itself (an in-filter focus always survives
              `localGraphView`, so it would render rather than reach here).
              Check the filter case first so the message is accurate in local
              mode too, falling back to "no concepts yet" only when the scope
              is genuinely empty. */}
          {scopedView.nodes.length > 0
            ? "All concepts are hidden by the current filters. Re-enable a relation or kind in the legend to show them."
            : "No concepts yet. As Tessera extracts entities and relationships from your sources, they will appear here."}
        </p>
      ) : (
        <>
          <div
            className="cg-controlbar"
            role="toolbar"
            aria-label="Concept graph controls"
            data-testid="concept-graph-controls"
          >
            <div className="cg-controlbar-group">
              <button
                type="button"
                className="cg-iconbtn"
                aria-label="Zoom out"
                onClick={() => zoomByButton(1 / 0.8)}
              >
                −
              </button>
              <span className="cg-zoom-readout" aria-live="off">
                {Math.round(zoom * 100)}%
              </span>
              <button
                type="button"
                className="cg-iconbtn"
                aria-label="Zoom in"
                onClick={() => zoomByButton(0.8)}
              >
                +
              </button>
            </div>
            <div className="cg-controlbar-sep" aria-hidden="true" />
            <div className="cg-controlbar-group">
              <button
                type="button"
                className="cg-iconbtn"
                onClick={fitToView}
                data-testid="concept-graph-fit"
              >
                Fit
              </button>
              <button type="button" className="cg-iconbtn" onClick={resetView}>
                Reset
              </button>
            </div>
            <div className="cg-controlbar-sep" aria-hidden="true" />
            <div className="cg-controlbar-group">
              <button
                type="button"
                className="cg-iconbtn"
                aria-pressed={labelsAll}
                aria-label="Toggle all labels"
                onClick={() => setLabelsAll((v) => !v)}
              >
                Labels
              </button>
              <button
                type="button"
                className="cg-iconbtn"
                aria-pressed={localMode}
                disabled={!selectedId}
                data-testid="concept-graph-local-toggle"
                onClick={() => setLocalMode((v) => !v)}
                title={
                  selectedId
                    ? "Show only the selected concept's neighborhood"
                    : "Select a concept to focus its local graph"
                }
              >
                Local graph
              </button>
              {localMode && (
                <label className="cg-hops">
                  <span>Hops</span>
                  <select
                    className="input"
                    aria-label="Local graph hop distance"
                    value={localHops}
                    onChange={(e) => setLocalHops(Number(e.target.value))}
                  >
                    <option value={1}>1</option>
                    <option value={2}>2</option>
                    <option value={3}>3</option>
                  </select>
                </label>
              )}
              <button
                type="button"
                className="cg-iconbtn"
                aria-pressed={decayMode}
                aria-label="Toggle time-based decay overlay"
                data-testid="concept-graph-decay-toggle"
                title="Color, size and fade concepts by how recently their memories were touched"
                onClick={() => {
                  setDecayMode((v) => !v);
                  setAsOf(null);
                }}
              >
                Decay
              </button>
            </div>
            <div className="cg-controlbar-sep" aria-hidden="true" />
            <div className="cg-controlbar-group cg-preset-group">
              <label className="cg-preset-pick">
                <span className="cg-sr-only">Saved view preset</span>
                <select
                  className="input"
                  aria-label="Saved view preset"
                  data-testid="concept-graph-preset-select"
                  value={currentPresetId ?? ""}
                  onChange={(e) => {
                    const preset = findPreset(
                      presetStore.presets,
                      e.target.value || null,
                    );
                    if (preset) applyPreset(preset);
                  }}
                >
                  <option value="">
                    {currentPresetId ? "Saved views" : "Custom view"}
                  </option>
                  {presetStore.presets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.id === presetStore.defaultPresetId ? "★ " : ""}
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <input
                type="text"
                className="input cg-preset-name"
                aria-label="New preset name"
                data-testid="concept-graph-preset-name"
                placeholder="Name this view"
                maxLength={60}
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    saveCurrentPreset();
                  }
                }}
              />
              <button
                type="button"
                className="cg-iconbtn"
                data-testid="concept-graph-preset-save"
                onClick={saveCurrentPreset}
                title="Save the current filter combination as a preset"
              >
                Save view
              </button>
              {currentPresetId && (
                <>
                  <button
                    type="button"
                    className="cg-iconbtn"
                    aria-pressed={presetStore.defaultPresetId === currentPresetId}
                    data-testid="concept-graph-preset-default"
                    onClick={() => setDefaultPreset(currentPresetId)}
                    title="Load this view automatically for this scope"
                  >
                    {presetStore.defaultPresetId === currentPresetId
                      ? "★ Default"
                      : "Set default"}
                  </button>
                  <button
                    type="button"
                    className="cg-iconbtn"
                    data-testid="concept-graph-preset-delete"
                    onClick={() => deletePreset(currentPresetId)}
                    title="Delete this preset"
                  >
                    Delete
                  </button>
                </>
              )}
            </div>
          </div>

          {decayMode && (
            <DecayControls
              bounds={timeBounds}
              asOf={asOf}
              onScrub={setAsOf}
              scheme={scheme}
            />
          )}

          {truncated && (
            <div className="cg-banner" role="status" data-testid="concept-graph-truncation">
              <span>
                Showing the {nodeCount} most-connected concepts (graph{" "}
                {view.truncation.replace(/_/g, " ")}).
              </span>
              {canShowMore && (
                <button
                  type="button"
                  className="cg-iconbtn"
                  data-testid="concept-graph-show-more"
                  onClick={() =>
                    setNodeCap((cap) => Math.min(NODE_CAP_CEILING, cap + maxNodes))
                  }
                >
                  Show more
                </button>
              )}
            </div>
          )}

          <div className="cg-body">
            <div className="cg-canvas-wrap">
              {useCanvas ? (
                <ConceptGraphCanvas
                  width={CANVAS_WIDTH}
                  height={height}
                  nodes={canvasNodes}
                  edges={canvasEdges}
                  edgeCurves={edgeCurves}
                  renderPos={renderPos}
                  viewBox={viewBox}
                  baseFit={baseFit}
                  selectedId={selectedId}
                  rovingId={effectiveRovingId}
                  focus={focus}
                  hubId={hubId}
                  labelsAll={labelsAll}
                  styleOf={canvasStyleOf}
                  relationColorOf={(rel) => RELATION_COLORS[rel]}
                  relationLabelOf={(rel) => RELATION_LABELS[rel]}
                  ariaLabel={`Concept graph with ${view.nodes.length} concepts and ${view.edges.length} relationships. Arrow keys move between concepts, Shift plus arrows pan, plus and minus zoom, 0 or F fits to view, Enter selects.`}
                  onSelect={setSelectedId}
                  onHover={setHoveredId}
                  onRove={setRovingId}
                  onDragNodeTo={dragNodeTo}
                  onClearSelection={clearSelection}
                  onExitLocal={exitLocal}
                  applyViewBox={applyViewBox}
                  zoomAround={zoomAround}
                  panBy={panBy}
                  fitToView={fitToView}
                  announce={announce}
                />
              ) : (
              <svg
                ref={attachSvg}
                className={`cg-canvas${isPanning ? " cg-panning" : ""}`}
                // `application` (rather than `img`) so a screen reader
                // forwards arrow / +/- / 0 keys to our canvas pan-zoom
                // handler instead of swallowing them for browse-mode
                // navigation. The roledescription keeps the announcement
                // meaningful, and the SVG is a tab stop for canvas control.
                role="application"
                aria-roledescription="Concept graph canvas"
                aria-label={`Concept graph with ${view.nodes.length} concepts and ${view.edges.length} relationships. Arrow keys pan, plus and minus zoom, 0 or F fits to view.`}
                tabIndex={0}
                viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
                style={{ aspectRatio: `${CANVAS_WIDTH} / ${height}` }}
                data-testid="concept-graph-svg"
                onPointerDown={onBackgroundPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endPointer}
                onPointerCancel={endPointer}
                onKeyDown={onCanvasKeyDown}
              >
                <defs>
                  {usedMarkerColors.map((color) => (
                    <marker
                      key={color}
                      id={markerId(color)}
                      viewBox="0 0 10 10"
                      refX="9"
                      refY="5"
                      markerWidth="7"
                      markerHeight="7"
                      orient="auto-start-reverse"
                    >
                      <path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
                    </marker>
                  ))}
                </defs>
                <g className="cg-edges">
                  {view.edges.map((edge) => {
                    // As-of scrubber: hide edges touching a not-yet-present
                    // concept (keeps layout stable; see `asOfHidden`).
                    if (asOfHidden.has(edge.from) || asOfHidden.has(edge.to)) {
                      return null;
                    }
                    const geo = edgeGeometry.get(edge.id);
                    if (!geo) return null;
                    const color = RELATION_COLORS[edge.relationType];
                    const dimmed = focus ? !focus.edgeIds.has(edge.id) : false;
                    const labelThisEdge = visibleEdgeLabelIds.has(edge.id);
                    return (
                      <g
                        key={edge.id}
                        className={`cg-edge${dimmed ? " cg-dim" : ""}`}
                      >
                        <path
                          d={geo.d}
                          fill="none"
                          stroke={color}
                          strokeWidth={1.5}
                          strokeOpacity={0.7}
                          markerEnd={`url(#${markerId(color)})`}
                        />
                        {labelThisEdge && (
                          <text
                            x={geo.labelPoint.x}
                            y={geo.labelPoint.y}
                            className="cg-edge-label"
                            fill={color}
                            textAnchor="middle"
                            dominantBaseline="middle"
                          >
                            {RELATION_LABELS[edge.relationType]}
                          </text>
                        )}
                      </g>
                    );
                  })}
                </g>
                <g className="cg-nodes" ref={nodesGroupRef}>
                  {paintNodes.map((node) => {
                    // As-of scrubber: omit concepts not yet present.
                    if (asOfHidden.has(node.id)) return null;
                    const pos = renderPos.get(node.id) ?? { x: node.x, y: node.y };
                    const isSelected = node.id === selectedId;
                    const dimmed = focus ? !focus.nodeIds.has(node.id) : false;
                    // Decay overlay overrides fill/opacity/size with the
                    // recency ramp; otherwise the lifecycle-state palette.
                    const decay = decayMode
                      ? decayStyleOf(node.state, node.id)
                      : null;
                    const fill = decay
                      ? decay.fill
                      : STATE_COLORS[node.state] ?? STATE_COLORS.unknown;
                    const dotRadius = decay
                      ? node.radius * decay.sizeFactor
                      : node.radius;
                    const dotOpacity = decay
                      ? decay.alpha
                      : isSelected
                        ? 0.95
                        : 0.78;
                    return (
                      <g
                        key={node.id}
                        className={`cg-node${dimmed ? " cg-dim" : ""}`}
                        transform={`translate(${pos.x}, ${pos.y})`}
                        role="button"
                        // Roving tabindex: exactly one node is in the tab
                        // order at a time; arrow keys move focus between the
                        // rest. Putting all (up to 600) nodes at tabIndex 0
                        // would itself be an accessibility problem.
                        tabIndex={node.id === effectiveRovingId ? 0 : -1}
                        aria-pressed={isSelected}
                        aria-label={`${node.label} (${node.state}, ${node.connectionsCount} connections)`}
                        data-testid={`concept-node-${node.id}`}
                        data-cg-node={node.id}
                        onPointerDown={(e) => onNodePointerDown(e, node)}
                        onClick={() => {
                          setRovingId(node.id);
                          onNodeClick(node.id);
                        }}
                        onPointerEnter={() => setHoveredId(node.id)}
                        onPointerLeave={() =>
                          setHoveredId((cur) => (cur === node.id ? null : cur))
                        }
                        onFocus={() => setHoveredId(node.id)}
                        onBlur={() =>
                          setHoveredId((cur) => (cur === node.id ? null : cur))
                        }
                        onKeyDown={(e) => onNodeKeyDown(e, node.id)}
                      >
                        {/* Generous transparent hit area for easier grabbing. */}
                        <circle className="cg-node-hit" r={node.radius + 8} />
                        <circle
                          className="cg-node-focusring"
                          r={node.radius + 5}
                        />
                        <circle
                          className="cg-node-dot"
                          r={dotRadius}
                          fill={fill}
                          fillOpacity={dotOpacity}
                          stroke={
                            isSelected
                              ? "var(--color-text, #111827)"
                              : "var(--color-surface, #ffffff)"
                          }
                          strokeWidth={isSelected ? 3 : 1.5}
                        />
                        {labelVisible(node) && (
                          <text
                            className="cg-node-label"
                            y={node.radius + 12}
                            textAnchor="middle"
                          >
                            {node.label.length > 22
                              ? `${node.label.slice(0, 21)}…`
                              : node.label}
                          </text>
                        )}
                      </g>
                    );
                  })}
                </g>
              </svg>
              )}
              {localMode && selectedNode && (
                <div className="cg-focus-pill" data-testid="concept-graph-focus-pill">
                  <span>
                    Local: {selectedNode.label} · {localHops}-hop
                  </span>
                  <button
                    type="button"
                    aria-label="Exit local graph"
                    onClick={() => setLocalMode(false)}
                  >
                    ×
                  </button>
                </div>
              )}
              {/* Dedicated, debounced live region. Drives concise selection
                  and local-graph announcements without re-reading the whole
                  detail panel (which is why the aside is no longer a live
                  region). */}
              <div
                className="cg-sr-only"
                role="status"
                aria-live="polite"
                data-testid="concept-graph-live"
              >
                {announcement}
              </div>
            </div>

            <aside className="cg-detail" style={{ maxHeight: `${height}px` }}>
              {selectedNode ? (
                <div data-testid="concept-detail">
                  <div className="cg-detail-head">
                    <h4 className="cg-detail-title">{selectedNode.label}</h4>
                    <span className={`badge badge-state-${selectedNode.state}`}>
                      {selectedNode.state}
                    </span>
                  </div>
                  <p className="cg-detail-meta">
                    {selectedNode.connectionsCount} connection
                    {selectedNode.connectionsCount === 1 ? "" : "s"}
                  </p>
                  <div className="cg-detail-actions">
                    <button
                      type="button"
                      className="cg-iconbtn"
                      aria-pressed={localMode}
                      onClick={() => setLocalMode((v) => !v)}
                    >
                      {localMode ? "Exit local graph" : "Focus local graph"}
                    </button>
                  </div>

                  <section className="cg-detail-section">
                    <h5 className="cg-detail-subhead">Relationships</h5>
                    {selectedRelations.length === 0 ? (
                      <p className="cg-detail-empty">No relationships in view.</p>
                    ) : (
                      <ul className="cg-detail-list">
                        {selectedRelations.map((rel) => (
                          <li key={rel.id}>
                            <span
                              className="cg-rel-dot"
                              style={{ background: RELATION_COLORS[rel.relationType] }}
                              aria-hidden="true"
                            />
                            {rel.direction === "out" ? (
                              <>
                                {RELATION_LABELS[rel.relationType]} →{" "}
                                <strong>{rel.otherLabel}</strong>
                              </>
                            ) : (
                              <>
                                <strong>{rel.otherLabel}</strong>{" "}
                                {RELATION_LABELS[rel.relationType]} → this
                              </>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>

                  <section className="cg-detail-section">
                    <h5 className="cg-detail-subhead">
                      Source evidence ({selectedEvidence.length})
                    </h5>
                    {selectedEvidence.length === 0 ? (
                      <p className="cg-detail-empty">
                        No source evidence found for this concept.
                      </p>
                    ) : (
                      <ul className="cg-evidence-list">
                        {selectedEvidence.map((mem) => (
                          <li key={mem.id} className="cg-evidence-item">
                            <p className="cg-evidence-content">{mem.content}</p>
                            <p className="cg-evidence-cite">
                              {mem.sourceId
                                ? `Source ${formatSourceId(mem.sourceId)}`
                                : "No source citation"}
                              {" · "}
                              {mem.observationType}
                            </p>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                </div>
              ) : (
                <p className="cg-detail-empty" data-testid="concept-detail-empty">
                  Select a concept to see its relationships and source evidence.
                </p>
              )}
            </aside>
          </div>
        </>
      )}

      {(relationsPresent.length > 0 || statesPresent.length > 0) && (
        <div className="cg-legends">
          {relationsPresent.length > 0 && (
            <div
              className="cg-legend"
              aria-label="Relationship types (click to toggle)"
              data-testid="concept-graph-legend"
            >
              <span className="cg-legend-caption">Relationships</span>
              {relationsPresent.map((rel) => {
                const enabled = !disabledRelations.has(rel);
                return (
                  <button
                    key={rel}
                    type="button"
                    className="cg-legend-item"
                    aria-pressed={enabled}
                    onClick={() => toggleRelation(rel)}
                  >
                    <span
                      className="cg-legend-swatch"
                      style={{ background: RELATION_COLORS[rel] }}
                      aria-hidden="true"
                    />
                    {RELATION_LABELS[rel]}
                  </button>
                );
              })}
              {view.truncation !== "complete" && (
                <span className="cg-legend-trunc">
                  View truncated ({view.truncation.replace(/_/g, " ")})
                </span>
              )}
            </div>
          )}
          {statesPresent.length > 0 && (
            <div
              className="cg-legend"
              aria-label="Node kinds (click to toggle)"
              data-testid="concept-graph-node-legend"
            >
              <span className="cg-legend-caption">Node kinds</span>
              {statesPresent.map((state) => {
                const enabled = !disabledStates.has(state);
                return (
                  <button
                    key={state}
                    type="button"
                    className="cg-legend-item"
                    aria-pressed={enabled}
                    onClick={() => toggleState(state)}
                  >
                    <span
                      className="cg-legend-dot"
                      style={{ background: STATE_COLORS[state] }}
                      aria-hidden="true"
                    />
                    {STATE_LABELS[state]}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      <style nonce={cspNonce}>{CONCEPT_GRAPH_STYLES}</style>
    </div>
  );
}
