import { useEffect, useId, useMemo, useState } from "react";
import { useCspNonce } from "../utils/cspNonce";
import { useConceptGraph } from "../hooks/useSubstrate";
import {
  computeRadialLayout,
  RELATION_LABELS,
  type ConceptGraphView,
  type ConceptRelation,
  type PositionedNode,
} from "../utils/conceptGraph";
import type { SubstrateMemoryInfo } from "../types/ipc";

/**
 * Interactive node-link view of the knowledge-substrate concept graph,
 * rendered with a dependency-free SVG layer (no D3 / canvas). Nodes are
 * concepts; edges are typed relations (`is_a`, `part_of`, `supersedes`,
 * `contradicts`, …). Selecting a node reveals its incident
 * relationships and the source evidence behind it (memories whose
 * content references the concept, each linking to its originating
 * source). A scope filter narrows the view to a single isolation scope.
 *
 * Layout + parsing live in `utils/conceptGraph` so this component is a
 * thin presentational shell over a deterministic, separately-tested
 * layout pass.
 */

const STATE_COLORS: Record<string, string> = {
  candidate: "var(--color-text-secondary, #6b7280)",
  canonical: "var(--color-primary, #2563eb)",
  superseded: "var(--color-warning, #d97706)",
  contradicted: "var(--color-danger, #dc2626)",
  deleted: "var(--color-text-tertiary, #9ca3af)",
  unknown: "var(--color-text-secondary, #6b7280)",
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

export interface ConceptGraphPanelProps {
  /** Scope label forwarded to the bridge; `null`/omitted = default scope. */
  scope?: string | null;
  /** Upper bound on nodes pulled from the substrate. */
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

/**
 * Static panel CSS, hoisted to a module-level constant so the rules are
 * identical for every mount and don't depend on props. The only dynamic
 * style is `.cg-detail`'s `max-height` (driven by the `height` prop),
 * which is applied as an inline style on the element itself rather than
 * baked into this stylesheet — otherwise two panels with different
 * `height` props mounted at once would collide in the cascade (last to
 * render wins for ALL instances). Keeping the dynamic bit inline removes
 * that implicit coupling to route exclusivity. (Devin Review PR #120.)
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
  }
  .cg-title { margin: 0; font-size: var(--font-size-md); }
  .cg-toolbar-controls {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm);
  }
  .cg-scope-filter {
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
  .cg-body {
    display: grid;
    grid-template-columns: minmax(0, 2fr) minmax(220px, 1fr);
    gap: var(--spacing-md);
    align-items: start;
  }
  .cg-canvas {
    width: 100%;
    height: auto;
    background: var(--color-surface-soft, #f9fafb);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md, 8px);
  }
  .cg-node { cursor: pointer; }
  .cg-node:focus { outline: none; }
  .cg-node:focus circle {
    stroke: var(--color-primary, #2563eb);
    stroke-width: 3;
  }
  .cg-node-label {
    font-size: 11px;
    fill: var(--color-text, #111827);
    pointer-events: none;
  }
  .cg-edge-label {
    font-size: 9px;
    opacity: 0.85;
    pointer-events: none;
  }
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
  .cg-detail-title { margin: 0; font-size: var(--font-size-md); }
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
  .cg-legend {
    display: flex;
    flex-wrap: wrap;
    gap: var(--spacing-md);
    font-size: var(--font-size-sm);
    color: var(--color-text-secondary);
  }
  .cg-legend-item, .cg-legend-trunc {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
  }
  .cg-legend-trunc { font-style: italic; }
  .cg-legend-swatch {
    width: 12px;
    height: 3px;
    border-radius: 2px;
  }
  @media (max-width: 720px) {
    .cg-body { grid-template-columns: 1fr; }
  }
`;

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
  const { graph, loading, error, refresh } = useConceptGraph(scope, maxNodes);
  const [scopeFilter, setScopeFilter] = useState<string>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Distinct scopes present in the loaded graph, for the filter
  // dropdown. Sorted for a stable order across renders.
  const scopes = useMemo(() => {
    const set = new Set<string>();
    for (const n of graph.nodes) set.add(n.scopeId);
    return [...set].sort();
  }, [graph.nodes]);

  // If the graph reloads (Refresh, or a parent re-fetch) and the currently
  // selected scope is no longer present, the view memo would filter down to
  // zero nodes — and the scope <select> is hidden when fewer than two scopes
  // remain, stranding the user on an empty graph with no way to clear the
  // now-invisible filter. Fall back to "all" (and drop the stale selection)
  // whenever the active scope drops out of the graph.
  useEffect(() => {
    if (scopeFilter !== "all" && !scopes.includes(scopeFilter)) {
      setScopeFilter("all");
      setSelectedId(null);
    }
  }, [scopes, scopeFilter]);

  // Apply the client-side scope filter to produce the view actually
  // rendered. Edges to filtered-out nodes are dropped so no dangling
  // lines remain.
  const view: ConceptGraphView = useMemo(() => {
    if (scopeFilter === "all") return graph;
    const nodes = graph.nodes.filter((n) => n.scopeId === scopeFilter);
    const ids = new Set(nodes.map((n) => n.id));
    const edges = graph.edges.filter(
      (e) => ids.has(e.from) && ids.has(e.to),
    );
    return { ...graph, nodes, edges };
  }, [graph, scopeFilter]);

  const layout = useMemo(
    () => computeRadialLayout(view, { width: CANVAS_WIDTH, height }),
    [view, height],
  );

  const positionById = useMemo(() => {
    const map = new Map<string, PositionedNode>();
    for (const n of layout.nodes) map.set(n.id, n);
    return map;
  }, [layout.nodes]);

  const selectedNode = useMemo(
    () => view.nodes.find((n) => n.id === selectedId) ?? null,
    [view.nodes, selectedId],
  );

  // Relations incident to the selected node, with the *other* node's
  // label resolved for display ("Atlas — is a → Project").
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

  // Source evidence: memories whose content mentions the concept label.
  // Best-effort correlation (the substrate doesn't expose a concept→
  // evidence join in the Session 1 bridge surface), capped so the detail
  // panel stays readable. We match on WORD BOUNDARIES rather than a raw
  // substring so a short label ("AI", "Go") doesn't spuriously match every
  // memory containing those letters mid-word ("maintain", "category"). Labels
  // with no word characters to anchor on fall back to a substring test.
  const selectedEvidence = useMemo(() => {
    if (!selectedNode) return [];
    const label = selectedNode.label.trim();
    if (!label) return [];
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matcher = /\w/.test(label)
      ? new RegExp(`\\b${escaped}\\b`, "i")
      : null;
    const needle = label.toLowerCase();
    return memories
      .filter((m) =>
        matcher
          ? matcher.test(m.content)
          : m.content.toLowerCase().includes(needle),
      )
      .slice(0, 8);
  }, [selectedNode, memories]);

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
          No concepts yet. As Tessera extracts entities and relationships
          from your sources, they will appear here.
        </p>
      ) : (
        <div className="cg-body">
          <svg
            className="cg-canvas"
            role="img"
            aria-label={`Concept graph with ${view.nodes.length} concepts and ${view.edges.length} relationships`}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            data-testid="concept-graph-svg"
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
                const from = positionById.get(edge.from);
                const to = positionById.get(edge.to);
                if (!from || !to) return null;
                const color = RELATION_COLORS[edge.relationType];
                const mx = (from.x + to.x) / 2;
                const my = (from.y + to.y) / 2;
                return (
                  <g key={edge.id} className="cg-edge">
                    <line
                      x1={from.x}
                      y1={from.y}
                      x2={to.x}
                      y2={to.y}
                      stroke={color}
                      strokeWidth={1.5}
                      strokeOpacity={0.7}
                      markerEnd={`url(#${markerId(color)})`}
                    />
                    <text
                      x={mx}
                      y={my}
                      className="cg-edge-label"
                      fill={color}
                      textAnchor="middle"
                    >
                      {RELATION_LABELS[edge.relationType]}
                    </text>
                  </g>
                );
              })}
            </g>
            <g className="cg-nodes">
              {layout.nodes.map((node) => {
                const isSelected = node.id === selectedId;
                const fill = STATE_COLORS[node.state] ?? STATE_COLORS.unknown;
                return (
                  <g
                    key={node.id}
                    className="cg-node"
                    transform={`translate(${node.x}, ${node.y})`}
                    role="button"
                    tabIndex={0}
                    aria-pressed={isSelected}
                    aria-label={`${node.label} (${node.state}, ${node.connectionsCount} connections)`}
                    data-testid={`concept-node-${node.id}`}
                    onClick={() => setSelectedId(node.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelectedId(node.id);
                      }
                    }}
                  >
                    <circle
                      r={node.radius}
                      fill={fill}
                      fillOpacity={isSelected ? 0.95 : 0.78}
                      stroke={
                        isSelected
                          ? "var(--color-text, #111827)"
                          : "var(--color-surface, #ffffff)"
                      }
                      strokeWidth={isSelected ? 3 : 1.5}
                    />
                    <text
                      className="cg-node-label"
                      y={node.radius + 12}
                      textAnchor="middle"
                    >
                      {node.label.length > 22
                        ? `${node.label.slice(0, 21)}…`
                        : node.label}
                    </text>
                  </g>
                );
              })}
            </g>
          </svg>

          <aside
            className="cg-detail"
            aria-live="polite"
            style={{ maxHeight: `${height}px` }}
          >
            {selectedNode ? (
              <div data-testid="concept-detail">
                <div className="cg-detail-head">
                  <h4 className="cg-detail-title">{selectedNode.label}</h4>
                  <span
                    className={`badge badge-state-${selectedNode.state}`}
                  >
                    {selectedNode.state}
                  </span>
                </div>
                <p className="cg-detail-meta">
                  {selectedNode.connectionsCount} connection
                  {selectedNode.connectionsCount === 1 ? "" : "s"}
                </p>

                <section className="cg-detail-section">
                  <h5 className="cg-detail-subhead">Relationships</h5>
                  {selectedRelations.length === 0 ? (
                    <p className="cg-detail-empty">
                      No relationships in view.
                    </p>
                  ) : (
                    <ul className="cg-detail-list">
                      {selectedRelations.map((rel) => (
                        <li key={rel.id}>
                          <span
                            className="cg-rel-dot"
                            style={{
                              background: RELATION_COLORS[rel.relationType],
                            }}
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
                              ? `Source ${mem.sourceId.slice(0, 8)}…`
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
                Select a concept to see its relationships and source
                evidence.
              </p>
            )}
          </aside>
        </div>
      )}

      {relationsUsed.length > 0 && (
        <div
          className="cg-legend"
          aria-label="Relationship legend"
          data-testid="concept-graph-legend"
        >
          {relationsUsed.map((rel) => (
            <span key={rel} className="cg-legend-item">
              <span
                className="cg-legend-swatch"
                style={{ background: RELATION_COLORS[rel] }}
                aria-hidden="true"
              />
              {RELATION_LABELS[rel]}
            </span>
          ))}
          {view.truncation !== "complete" && (
            <span className="cg-legend-trunc">
              View truncated ({view.truncation.replace(/_/g, " ")})
            </span>
          )}
        </div>
      )}

      <style nonce={cspNonce}>{CONCEPT_GRAPH_STYLES}</style>
    </div>
  );
}
