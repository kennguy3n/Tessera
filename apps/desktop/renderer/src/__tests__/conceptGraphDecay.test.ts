import { describe, it, expect } from "vitest";
import {
  buildConceptDecayMap,
  computeTimeBounds,
  isPresentAsOf,
  recencyFraction,
  decayOpacity,
  decaySizeFactor,
  decayColor,
  decayLegendStops,
  lerpHex,
  TIMELESS_DECAY,
  type ConceptDecay,
} from "../utils/conceptGraphDecay";
import { conceptMentionMatcher } from "../utils/memories";
import type { ConceptGraphNode } from "../utils/conceptGraph";
import type { SubstrateMemoryInfo } from "../types/ipc";

function concept(id: string, label: string): ConceptGraphNode {
  return {
    id,
    label,
    state: "canonical",
    scopeId: "s",
    connectionsCount: 0,
  };
}

function memory(
  partial: Partial<SubstrateMemoryInfo> & { content: string },
): SubstrateMemoryInfo {
  return {
    id: "m",
    scopeId: "s",
    observationType: "fact",
    content: partial.content,
    state: partial.state ?? "canonical",
    retentionScore: partial.retentionScore ?? 0.5,
    pinCount: partial.pinCount ?? 0,
    retrievalCount: partial.retrievalCount ?? 0,
    corroborationCount: partial.corroborationCount ?? 0,
    createdAt: partial.createdAt ?? 1000,
    lastAccessedAt: partial.lastAccessedAt ?? 1000,
    sourceId: partial.sourceId ?? null,
  };
}

describe("buildConceptDecayMap", () => {
  it("aggregates real memory fields per concept on word boundaries", () => {
    const nodes = [concept("a", "Atlas"), concept("b", "Beacon")];
    const memories = [
      memory({
        content: "Atlas is the codename",
        createdAt: 100,
        lastAccessedAt: 500,
        retentionScore: 0.6,
        pinCount: 1,
        state: "reinforced",
      }),
      memory({
        content: "We renamed Atlas again",
        createdAt: 50,
        lastAccessedAt: 800,
        retentionScore: 0.9,
        pinCount: 2,
        state: "canonical",
      }),
    ];
    const map = buildConceptDecayMap(nodes, memories);
    const a = map.get("a") as ConceptDecay;
    expect(a.memoryCount).toBe(2);
    expect(a.createdAt).toBe(50); // earliest
    expect(a.lastAccessedAt).toBe(800); // latest
    expect(a.retention).toBeCloseTo(0.9); // max
    expect(a.pinCount).toBe(3); // sum
    expect(a.bucket).toBe("active");
    // 'Beacon' is mentioned nowhere → timeless.
    expect(map.get("b")).toEqual(TIMELESS_DECAY);
  });

  it("does not match mid-word substrings", () => {
    const map = buildConceptDecayMap(
      [concept("a", "Atlas")],
      [memory({ content: "Atlassian makes Jira" })],
    );
    expect(map.get("a")).toEqual(TIMELESS_DECAY);
  });

  it("keeps the most-alive bucket across mixed memories", () => {
    const map = buildConceptDecayMap(
      [concept("a", "Atlas")],
      [
        memory({ content: "Atlas archived", state: "archived" }),
        memory({ content: "Atlas superseded", state: "superseded" }),
      ],
    );
    expect((map.get("a") as ConceptDecay).bucket).toBe("fading");
  });
});

describe("conceptMentionMatcher", () => {
  it("compiles once and is reusable across many contents", () => {
    const mentionsAtlas = conceptMentionMatcher("Atlas");
    expect(mentionsAtlas("Atlas shipped")).toBe(true);
    expect(mentionsAtlas("we love ATLAS")).toBe(true); // case-insensitive
    expect(mentionsAtlas("Atlassian makes Jira")).toBe(false); // word boundary
    expect(mentionsAtlas("no mention here")).toBe(false);
  });

  it("falls back to substring for word-character-less labels (e.g. CJK)", () => {
    const matcher = conceptMentionMatcher("地图");
    expect(matcher("这是地图服务")).toBe(true);
    expect(matcher("unrelated")).toBe(false);
  });

  it("never matches for an empty/blank label", () => {
    expect(conceptMentionMatcher("   ")("anything")).toBe(false);
  });
});

describe("computeTimeBounds", () => {
  it("spans the earliest creation and the latest access", () => {
    const map = new Map<string, ConceptDecay>([
      ["a", { ...TIMELESS_DECAY, createdAt: 100, lastAccessedAt: 400, memoryCount: 1 }],
      ["b", { ...TIMELESS_DECAY, createdAt: 50, lastAccessedAt: 900, memoryCount: 1 }],
    ]);
    expect(computeTimeBounds(map)).toEqual({ min: 50, max: 900 });
  });

  it("returns nulls when no concept carries time data", () => {
    const map = new Map<string, ConceptDecay>([["a", TIMELESS_DECAY]]);
    expect(computeTimeBounds(map)).toEqual({ min: null, max: null });
  });
});

describe("isPresentAsOf", () => {
  it("treats timeless concepts as always present", () => {
    expect(isPresentAsOf(TIMELESS_DECAY, 0)).toBe(true);
  });
  it("includes a concept only once it has been created", () => {
    const d: ConceptDecay = { ...TIMELESS_DECAY, createdAt: 500, memoryCount: 1 };
    expect(isPresentAsOf(d, 499)).toBe(false);
    expect(isPresentAsOf(d, 500)).toBe(true);
    expect(isPresentAsOf(d, 600)).toBe(true);
  });
});

describe("recencyFraction", () => {
  const bounds = { min: 0, max: 1000 };
  it("returns 1 for a concept accessed right at the scrubber instant", () => {
    const d: ConceptDecay = {
      ...TIMELESS_DECAY,
      lastAccessedAt: 800,
      memoryCount: 1,
    };
    expect(recencyFraction(d, 800, bounds)).toBeCloseTo(1);
  });
  it("decays toward 0 as the last access recedes from the scrubber", () => {
    const d: ConceptDecay = {
      ...TIMELESS_DECAY,
      lastAccessedAt: 200,
      memoryCount: 1,
    };
    // accessed at 200, scrubber at 1000 → age 800 / span 1000 → t = 0.2.
    expect(recencyFraction(d, 1000, bounds)).toBeCloseTo(0.2);
  });
  it("returns null for timeless concepts or a zero-width span", () => {
    expect(recencyFraction(TIMELESS_DECAY, 500, bounds)).toBeNull();
    const d: ConceptDecay = {
      ...TIMELESS_DECAY,
      lastAccessedAt: 5,
      memoryCount: 1,
    };
    expect(recencyFraction(d, 5, { min: 5, max: 5 })).toBe(1);
  });
  it("never reads future access as fresher than the scrubber instant", () => {
    const d: ConceptDecay = {
      ...TIMELESS_DECAY,
      lastAccessedAt: 900,
      memoryCount: 1,
    };
    // scrubber at 500, access at 900 (future) → clamped to 500 → t = 1.
    expect(recencyFraction(d, 500, bounds)).toBeCloseTo(1);
  });
});

describe("decay ramps", () => {
  it("opacity increases with recency and has a neutral null case", () => {
    expect(decayOpacity(0)).toBeLessThan(decayOpacity(1));
    expect(decayOpacity(null)).toBeGreaterThan(0);
    expect(decayOpacity(2)).toBeLessThanOrEqual(0.95);
  });
  it("size factor grows with recency, identity for null", () => {
    expect(decaySizeFactor(null)).toBe(1);
    expect(decaySizeFactor(0)).toBeLessThan(decaySizeFactor(1));
  });
  it("color is a valid hex and differs across the ramp", () => {
    const light0 = decayColor(0, "light");
    const light1 = decayColor(1, "light");
    expect(light0).toMatch(/^#[0-9a-f]{6}$/);
    expect(light1).toMatch(/^#[0-9a-f]{6}$/);
    expect(light0).not.toBe(light1);
    // Theme variants differ.
    expect(decayColor(0.5, "dark")).not.toBe(decayColor(0.5, "light"));
    // Timeless null → neutral color.
    expect(decayColor(null, "light")).toMatch(/^#[0-9a-f]{6}$/);
  });
  it("legend stops cover oldest→newest", () => {
    const stops = decayLegendStops("light", 5);
    expect(stops).toHaveLength(5);
    expect(stops[0].t).toBe(0);
    expect(stops[4].t).toBe(1);
  });
});

describe("lerpHex", () => {
  it("interpolates endpoints and midpoint", () => {
    expect(lerpHex("#000000", "#ffffff", 0)).toBe("#000000");
    expect(lerpHex("#000000", "#ffffff", 1)).toBe("#ffffff");
    expect(lerpHex("#000000", "#ffffff", 0.5)).toBe("#808080");
  });
  it("clamps out-of-range t", () => {
    expect(lerpHex("#000000", "#ffffff", -1)).toBe("#000000");
    expect(lerpHex("#000000", "#ffffff", 2)).toBe("#ffffff");
  });
});
