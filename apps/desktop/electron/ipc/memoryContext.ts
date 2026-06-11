/**
 * Builds the additive "Knowledge context" block that
 * `artifacts:generateFromTemplate` feeds into the Rust generator
 * (`bridge_generate_from_template`'s optional `memoryContext` param).
 *
 * Generation is otherwise a pure source-retrieval step in Rust; this
 * module is the seam where, before generating, we pull the
 * knowledge-substrate memory plane + concept graph and distill the most
 * relevant extracted entities/facts/decisions and concept
 * relationships into a compact, deterministic set of context lines. The
 * generated artifact then draws on the substrate's accumulated
 * knowledge, not just raw chunk hits.
 *
 * Kept separate from `artifacts.ts` (and free of Electron imports) so
 * the relevance/formatting logic is unit-testable in isolation. All
 * substrate access is best-effort: any failure yields an empty context
 * so generation never regresses when the substrate is empty or
 * unavailable.
 */
import type { NativeBridge } from "../appState";
import {
  isActiveMemoryState,
  type SubstrateMemoryInfo,
} from "../../shared/types";

/** Max memory lines folded into the context (keeps prompts bounded). */
const MAX_MEMORY_LINES = 12;
/** Max concept-relationship lines folded into the context. */
const MAX_RELATION_LINES = 8;

function isActive(memory: SubstrateMemoryInfo): boolean {
  return isActiveMemoryState(memory.state);
}

/**
 * Collapse any internal whitespace (newlines, tabs, runs of spaces) in a
 * memory's content into single spaces so it stays on one markdown list
 * line. Substrate observations are short single-line strings in practice,
 * but a multi-line value would otherwise break the list structure (the
 * continuation line wouldn't be indented under the `-`). (Devin Review
 * PR #120.)
 */
function toSingleLine(content: string): string {
  return content.replace(/\s+/g, " ").trim();
}

/** Strongest-signal-first ordering, with deterministic tie-breaks. */
function memorySignal(m: SubstrateMemoryInfo): number {
  return m.corroborationCount * 3 + m.retrievalCount + m.pinCount * 2;
}

function compareMemories(
  a: SubstrateMemoryInfo,
  b: SubstrateMemoryInfo,
): number {
  const diff = memorySignal(b) - memorySignal(a);
  if (diff !== 0) return diff;
  if (b.retentionScore !== a.retentionScore) {
    return b.retentionScore - a.retentionScore;
  }
  return a.content.localeCompare(b.content);
}

function titleCase(value: string): string {
  return value
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Select + format the memory lines.
 *
 * Scoping is an explicit user signal and is honored strictly:
 *  - When `sourceIds` is non-empty, ONLY memories extracted from those
 *    sources are eligible. If none of the selected sources have
 *    memories yet, we inject no memory lines rather than silently
 *    pulling in memories from sources the user did not pick — a generic
 *    global fallback there would leak unrelated-source context into a
 *    deliberately scoped artifact. (Devin Review PR #120.)
 *  - When `sourceIds` is empty (no scope requested), the whole active
 *    working set is eligible — that's the intended "draw on everything
 *    Tessera knows" path.
 *
 * Note: `memories` is already tenant/workspace-scoped by the bridge, so
 * this is purely about respecting in-workspace source selection, never
 * cross-tenant isolation (which the substrate enforces upstream).
 */
export function selectMemoryLines(
  memories: SubstrateMemoryInfo[],
  sourceIds: readonly string[],
): string[] {
  const active = memories.filter(isActive);
  const selected = new Set(sourceIds);
  const pool =
    selected.size > 0
      ? active.filter((m) => m.sourceId !== null && selected.has(m.sourceId))
      : active;

  return [...pool]
    .sort(compareMemories)
    .slice(0, MAX_MEMORY_LINES)
    .map((m) => {
      const pct = Math.round(Math.max(0, Math.min(1, m.retentionScore)) * 100);
      return `- [${titleCase(m.observationType)}] ${toSingleLine(m.content)} (${m.state}, ${pct}% retained)`;
    });
}

interface RawGraphNode {
  id?: unknown;
  label?: unknown;
}
interface RawGraphEdge {
  from?: unknown;
  to?: unknown;
  relation_type?: unknown;
}

/**
 * Parse the concept-graph JSON (the bridge returns a string) and format
 * the top relationships as readable lines ("Atlas — is a → Project").
 * Defensive: malformed JSON or unexpected shapes yield no lines rather
 * than throwing into the generation path.
 *
 * Concept relations cannot be source-scoped at this layer: the
 * concept-graph wire shape attributes nodes/edges to a `scope_id` (the
 * workspace scope), never to an individual source — concepts are
 * aggregate entities synthesized ACROSS sources, and an edge like
 * "Atlas — is_a → Project" has no single owning source to filter on.
 * Because of that, {@link buildMemoryContext} only folds relations in
 * for UNSCOPED generation; a source-scoped artifact omits them entirely
 * rather than leaking workspace-wide relationships the user didn't
 * select. (Devin Review PR #120.)
 */
export function selectRelationLines(conceptGraphJson: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(conceptGraphJson);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const obj = parsed as { nodes?: unknown; edges?: unknown };
  const nodes = Array.isArray(obj.nodes) ? (obj.nodes as RawGraphNode[]) : [];
  const edges = Array.isArray(obj.edges) ? (obj.edges as RawGraphEdge[]) : [];

  const labelById = new Map<string, string>();
  for (const n of nodes) {
    if (typeof n.id === "string") {
      labelById.set(n.id, typeof n.label === "string" ? n.label : n.id);
    }
  }

  const lines: string[] = [];
  for (const e of edges) {
    if (typeof e.from !== "string" || typeof e.to !== "string") continue;
    const from = labelById.get(e.from) ?? e.from;
    const to = labelById.get(e.to) ?? e.to;
    const rel =
      typeof e.relation_type === "string"
        ? e.relation_type.replace(/_/g, " ")
        : "related to";
    lines.push(`- ${from} — ${rel} → ${to}`);
    if (lines.length >= MAX_RELATION_LINES) break;
  }
  return lines;
}

/**
 * Assemble the full context line list passed to the generator. Pulls
 * memories + concept graph from the substrate via the native bridge,
 * distills them, and returns a flat `string[]` (memory lines first,
 * then a blank separator + relationship lines). Returns `[]` on any
 * substrate error so generation degrades gracefully.
 *
 * Scoping rules:
 *  - Memory lines are always strictly source-scoped when `sourceIds` is
 *    non-empty (see {@link selectMemoryLines}).
 *  - Concept-relationship lines are only included for UNSCOPED
 *    generation (`sourceIds` empty). A source-scoped artifact omits
 *    relations entirely, since the concept graph has no per-source
 *    attribution to filter on. (Devin Review PR #120.)
 */
export function buildMemoryContext(
  bridge: NativeBridge,
  sourceIds: readonly string[],
): string[] {
  let memoryLines: string[] = [];
  try {
    memoryLines = selectMemoryLines(bridge.bridgeGetMemories(null), sourceIds);
  } catch {
    memoryLines = [];
  }

  let relationLines: string[] = [];
  // Concept relations are workspace-level aggregate knowledge with no
  // per-source attribution (see selectRelationLines). For a SOURCE-SCOPED
  // artifact we omit them entirely — folding in workspace-wide
  // relationships would leak structure derived from sources the user did
  // not select. They're only included for unscoped ("everything Tessera
  // knows") generation. (Devin Review PR #120.)
  if (sourceIds.length === 0) {
    try {
      relationLines = selectRelationLines(bridge.bridgeGetConceptGraph(null, 64));
    } catch {
      relationLines = [];
    }
  }

  if (memoryLines.length === 0 && relationLines.length === 0) return [];

  const out: string[] = [];
  if (memoryLines.length > 0) {
    out.push("### Extracted knowledge", ...memoryLines);
  }
  if (relationLines.length > 0) {
    if (out.length > 0) out.push("");
    out.push("### Concept relationships", ...relationLines);
  }
  return out;
}
