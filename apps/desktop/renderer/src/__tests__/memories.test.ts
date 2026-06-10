import { describe, it, expect } from "vitest";
import {
  decayBucket,
  decayBadgeVariant,
  observationTypeLabel,
  filterMemories,
  countByBucket,
  formatRetention,
  DECAY_BUCKETS,
} from "../utils/memories";
import type { SubstrateMemoryInfo } from "../types/ipc";

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

describe("decayBucket", () => {
  it("maps the live working-set states to 'active'", () => {
    for (const s of ["candidate", "reinforced", "consolidated", "canonical"]) {
      expect(decayBucket(s)).toBe("active");
    }
  });

  it("maps superseded to 'fading'", () => {
    expect(decayBucket("superseded")).toBe("fading");
  });

  it("maps archived/deleted and unknown future states to 'archived'", () => {
    for (const s of ["archived", "deleted", "some_future_state"]) {
      expect(decayBucket(s)).toBe("archived");
    }
  });

  it("is case-insensitive", () => {
    expect(decayBucket("CANONICAL")).toBe("active");
    expect(decayBucket("Superseded")).toBe("fading");
  });
});

describe("decayBadgeVariant", () => {
  it("covers every bucket", () => {
    expect(DECAY_BUCKETS.map(decayBadgeVariant)).toEqual([
      "success",
      "warning",
      "info",
    ]);
  });
});

describe("observationTypeLabel", () => {
  it("title-cases known and unknown observation types", () => {
    expect(observationTypeLabel("entity")).toBe("Entity");
    expect(observationTypeLabel("decision")).toBe("Decision");
    expect(observationTypeLabel("open_question")).toBe("Open Question");
  });
});

describe("filterMemories", () => {
  const memories = [
    mem({ id: "1", state: "canonical", content: "Atlas project kickoff", observationType: "entity" }),
    mem({ id: "2", state: "superseded", content: "old deadline", observationType: "fact" }),
    mem({ id: "3", state: "archived", content: "archived note", observationType: "task" }),
  ];

  it("returns all when bucket=all and query empty", () => {
    expect(filterMemories(memories, { bucket: "all", query: "" })).toHaveLength(3);
  });

  it("filters by decay bucket", () => {
    expect(
      filterMemories(memories, { bucket: "active", query: "" }).map((m) => m.id),
    ).toEqual(["1"]);
    expect(
      filterMemories(memories, { bucket: "fading", query: "" }).map((m) => m.id),
    ).toEqual(["2"]);
  });

  it("matches query against content and observation type (case-insensitive)", () => {
    expect(
      filterMemories(memories, { bucket: "all", query: "atlas" }).map((m) => m.id),
    ).toEqual(["1"]);
    expect(
      filterMemories(memories, { bucket: "all", query: "TASK" }).map((m) => m.id),
    ).toEqual(["3"]);
  });

  it("combines bucket and query", () => {
    expect(
      filterMemories(memories, { bucket: "active", query: "old" }),
    ).toHaveLength(0);
  });
});

describe("countByBucket", () => {
  it("tallies each bucket", () => {
    const counts = countByBucket([
      mem({ state: "canonical" }),
      mem({ state: "reinforced" }),
      mem({ state: "superseded" }),
      mem({ state: "deleted" }),
    ]);
    expect(counts).toEqual({ active: 2, fading: 1, archived: 1 });
  });
});

describe("formatRetention", () => {
  it("formats and clamps to a whole-number percentage", () => {
    expect(formatRetention(0)).toBe("0%");
    expect(formatRetention(0.5)).toBe("50%");
    expect(formatRetention(1)).toBe("100%");
    expect(formatRetention(1.5)).toBe("100%");
    expect(formatRetention(-0.2)).toBe("0%");
  });
});
