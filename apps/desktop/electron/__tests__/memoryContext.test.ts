/**
 * Tests for the artifact-generation memory-context builder
 * (`ipc/memoryContext.ts`). This is the seam where
 * `artifacts:generateFromTemplate` augments the source pack with the
 * knowledge substrate before generation, so we assert:
 *
 *   1. Relevance selection: active-state filtering, source scoping with
 *      global fallback, signal-based ordering, and the line cap.
 *   2. Concept-graph parsing into readable relationship lines (and
 *      defensiveness against malformed JSON).
 *   3. `buildMemoryContext` composition + best-effort degradation when
 *      the bridge throws.
 */
import { describe, it, expect, vi } from "vitest";
import {
  selectMemoryLines,
  selectRelationLines,
  buildMemoryContext,
} from "../ipc/memoryContext";
import type { SubstrateMemoryInfo } from "../../shared/types";
import type { NativeBridge } from "../appState";

function mem(over: Partial<SubstrateMemoryInfo>): SubstrateMemoryInfo {
  return {
    id: over.id ?? "id",
    scopeId: "scope",
    observationType: over.observationType ?? "fact",
    content: over.content ?? "content",
    state: over.state ?? "canonical",
    retentionScore: over.retentionScore ?? 0.5,
    pinCount: over.pinCount ?? 0,
    retrievalCount: over.retrievalCount ?? 0,
    corroborationCount: over.corroborationCount ?? 0,
    createdAt: 0,
    lastAccessedAt: 0,
    sourceId: over.sourceId ?? null,
  };
}

describe("selectMemoryLines", () => {
  it("excludes archived/deleted/superseded memories", () => {
    const lines = selectMemoryLines(
      [
        mem({ content: "live", state: "canonical" }),
        mem({ content: "fading", state: "superseded" }),
        mem({ content: "gone", state: "archived" }),
        mem({ content: "deleted", state: "deleted" }),
      ],
      [],
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("live");
  });

  it("scopes strictly to selected sources and never leaks other sources", () => {
    const memories = [
      mem({ content: "from A", sourceId: "A" }),
      mem({ content: "from B", sourceId: "B" }),
    ];
    expect(selectMemoryLines(memories, ["A"]).join("\n")).toContain("from A");
    expect(selectMemoryLines(memories, ["A"]).join("\n")).not.toContain("from B");
    // When the user explicitly scopes to a source with no memories, we
    // inject NOTHING rather than leaking unrelated-source context into
    // the deliberately-scoped artifact. (Devin Review PR #120.)
    expect(selectMemoryLines(memories, ["Z"])).toEqual([]);
  });

  it("uses the whole active set only when no scope is requested", () => {
    const memories = [
      mem({ content: "from A", sourceId: "A" }),
      mem({ content: "from B", sourceId: "B" }),
    ];
    // Empty sourceIds == "draw on everything Tessera knows".
    expect(selectMemoryLines(memories, [])).toHaveLength(2);
  });

  it("orders by corroboration/retrieval/pin signal", () => {
    const lines = selectMemoryLines(
      [
        mem({ content: "weak", corroborationCount: 0 }),
        mem({ content: "strong", corroborationCount: 5 }),
      ],
      [],
    );
    expect(lines[0]).toContain("strong");
  });

  it("formats type, state and retention percentage", () => {
    const [line] = selectMemoryLines(
      [mem({ content: "Atlas", observationType: "entity", state: "canonical", retentionScore: 0.875 })],
      [],
    );
    expect(line).toBe("- [Entity] Atlas (canonical, 88% retained)");
  });

  it("caps the number of lines", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      mem({ id: `m${i}`, content: `c${i}`, corroborationCount: i }),
    );
    expect(selectMemoryLines(many, [])).toHaveLength(12);
  });

  it("collapses internal whitespace so multi-line content stays one list line", () => {
    const [line] = selectMemoryLines(
      [
        mem({
          content: "Atlas team\n  owns   the\n\tmigration",
          observationType: "decision",
          state: "canonical",
          retentionScore: 1,
        }),
      ],
      [],
    );
    expect(line).toBe("- [Decision] Atlas team owns the migration (canonical, 100% retained)");
    expect(line).not.toContain("\n");
  });
});

describe("selectRelationLines", () => {
  it("formats edges using node labels and snake_case→spaced relation", () => {
    const json = JSON.stringify({
      nodes: [
        { id: "a", label: "Atlas" },
        { id: "b", label: "Project" },
      ],
      edges: [{ from: "a", to: "b", relation_type: "is_a" }],
    });
    expect(selectRelationLines(json)).toEqual(["- Atlas — is a → Project"]);
  });

  it("returns no lines for malformed JSON", () => {
    expect(selectRelationLines("not json")).toEqual([]);
    expect(selectRelationLines("null")).toEqual([]);
    expect(selectRelationLines("[]")).toEqual([]);
  });

  it("falls back to ids when labels are missing and caps relations", () => {
    const edges = Array.from({ length: 20 }, (_, i) => ({
      from: `n${i}`,
      to: `n${i + 1}`,
      relation_type: "part_of",
    }));
    const lines = selectRelationLines(JSON.stringify({ nodes: [], edges }));
    expect(lines).toHaveLength(8);
    expect(lines[0]).toBe("- n0 — part of → n1");
  });
});

describe("buildMemoryContext", () => {
  function bridgeWith(
    memories: SubstrateMemoryInfo[],
    graphJson: string,
  ): NativeBridge {
    return {
      bridgeGetMemories: vi.fn().mockReturnValue(memories),
      bridgeGetConceptGraph: vi.fn().mockReturnValue(graphJson),
    } as unknown as NativeBridge;
  }

  it("composes extracted-knowledge and concept-relationship sections", () => {
    const bridge = bridgeWith(
      [mem({ content: "Atlas", observationType: "entity" })],
      JSON.stringify({
        nodes: [
          { id: "a", label: "Atlas" },
          { id: "b", label: "Project" },
        ],
        edges: [{ from: "a", to: "b", relation_type: "is_a" }],
      }),
    );
    const ctx = buildMemoryContext(bridge, []);
    expect(ctx).toContain("### Extracted knowledge");
    expect(ctx).toContain("### Concept relationships");
    expect(ctx.some((l) => l.includes("Atlas — is a → Project"))).toBe(true);
  });

  it("omits concept relations when the artifact is source-scoped", () => {
    const bridge = bridgeWith(
      [mem({ content: "Atlas", observationType: "entity", sourceId: "A" })],
      JSON.stringify({
        nodes: [
          { id: "a", label: "Atlas" },
          { id: "b", label: "Project" },
        ],
        edges: [{ from: "a", to: "b", relation_type: "is_a" }],
      }),
    );
    // Source-scoped: only the in-scope memory line survives; the
    // workspace-level concept relations are dropped entirely (they have
    // no per-source attribution to filter on). (Devin Review PR #120.)
    const ctx = buildMemoryContext(bridge, ["A"]);
    expect(ctx).toContain("### Extracted knowledge");
    expect(ctx).not.toContain("### Concept relationships");
    expect(ctx.some((l) => l.includes("Atlas — is a → Project"))).toBe(false);
    // The concept graph isn't even fetched for a scoped artifact.
    expect(bridge.bridgeGetConceptGraph).not.toHaveBeenCalled();
  });

  it("returns an empty context when the substrate is empty", () => {
    const bridge = bridgeWith([], '{"nodes":[],"edges":[]}');
    expect(buildMemoryContext(bridge, [])).toEqual([]);
  });

  it("degrades to an empty context when the bridge throws", () => {
    const bridge = {
      bridgeGetMemories: vi.fn(() => {
        throw new Error("bridge down");
      }),
      bridgeGetConceptGraph: vi.fn(() => {
        throw new Error("bridge down");
      }),
    } as unknown as NativeBridge;
    expect(buildMemoryContext(bridge, [])).toEqual([]);
  });
});
