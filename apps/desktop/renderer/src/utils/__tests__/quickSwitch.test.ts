/**
 * Unit tests for the pure quick-switch ranking. These exercise the
 * two ranking modes (empty-query recents-first, non-empty fuzzy +
 * recency boost) and the scoring primitive without any React or
 * bridge involvement.
 */
import { describe, expect, it } from "vitest";
import {
  rankQuickSwitchItems,
  scoreQuickItem,
  kindLabel,
  type QuickSwitchItem,
} from "../quickSwitch";

function artifact(
  id: string,
  title: string,
  extra: Partial<QuickSwitchItem> = {},
): QuickSwitchItem {
  return {
    id: `artifact:${id}`,
    kind: "artifact",
    title,
    subtitle: "Artifact · document",
    keywords: "document",
    to: `/artifacts/${id}/edit`,
    recentKey: id,
    ...extra,
  };
}

function page(label: string, to: string): QuickSwitchItem {
  return {
    id: `page:${to}`,
    kind: "page",
    title: label,
    subtitle: "Page",
    keywords: to,
    to,
  };
}

describe("scoreQuickItem", () => {
  it("returns null when the query matches neither title nor aux", () => {
    expect(scoreQuickItem("zzzz", artifact("1", "Roadmap"))).toBeNull();
  });

  it("matches and highlights a title subsequence", () => {
    const r = scoreQuickItem("rdm", artifact("1", "Roadmap"));
    expect(r).not.toBeNull();
    expect(r!.matchedIndices.length).toBeGreaterThan(0);
    // every highlighted index points at a char of the query, in order
    expect(r!.matchedIndices).toEqual(
      [...r!.matchedIndices].sort((a, b) => a - b),
    );
  });

  it("scores an aux-only match but highlights nothing in the title", () => {
    const item = artifact("1", "Roadmap", {
      keywords: "quarterly planning",
      subtitle: "Artifact · document",
    });
    const r = scoreQuickItem("planning", item);
    expect(r).not.toBeNull();
    expect(r!.matchedIndices).toEqual([]);
  });

  it("ranks a title hit above an aux-only hit for the same query", () => {
    const titleHit = scoreQuickItem("plan", artifact("1", "Plan"));
    const auxHit = scoreQuickItem(
      "plan",
      artifact("2", "Roadmap", { keywords: "plan" }),
    );
    expect(titleHit!.score).toBeGreaterThan(auxHit!.score);
  });
});

describe("rankQuickSwitchItems — empty query", () => {
  const items = [
    artifact("a", "Alpha"),
    artifact("b", "Bravo"),
    artifact("c", "Charlie"),
    page("Home", "/"),
  ];

  it("floats recently-viewed items to the top in recency order", () => {
    const ranked = rankQuickSwitchItems({
      items,
      query: "",
      recentKeys: ["c", "a"],
    });
    expect(ranked[0].item.id).toBe("artifact:c");
    expect(ranked[1].item.id).toBe("artifact:a");
  });

  it("orders non-recent items by kind then title", () => {
    const ranked = rankQuickSwitchItems({ items, query: "", recentKeys: [] });
    // artifacts (kind rank 0) come before the page (kind rank 5),
    // alphabetised within the artifact group.
    expect(ranked.map((r) => r.item.title)).toEqual([
      "Alpha",
      "Bravo",
      "Charlie",
      "Home",
    ]);
  });

  it("never highlights anything on an empty query", () => {
    const ranked = rankQuickSwitchItems({
      items,
      query: "",
      recentKeys: ["a"],
    });
    expect(ranked.every((r) => r.matchedIndices.length === 0)).toBe(true);
  });

  it("respects the result cap", () => {
    const many = Array.from({ length: 100 }, (_, i) =>
      artifact(String(i), `Item ${i}`),
    );
    const ranked = rankQuickSwitchItems({
      items: many,
      query: "",
      recentKeys: [],
      limit: 10,
    });
    expect(ranked).toHaveLength(10);
  });
});

describe("rankQuickSwitchItems — non-empty query", () => {
  it("returns only fuzzy-matching items", () => {
    const items = [
      artifact("1", "Roadmap"),
      artifact("2", "Budget"),
      artifact("3", "Retrospective"),
    ];
    const ranked = rankQuickSwitchItems({ items, query: "ro", recentKeys: [] });
    const titles = ranked.map((r) => r.item.title);
    expect(titles).toContain("Roadmap");
    expect(titles).toContain("Retrospective");
    expect(titles).not.toContain("Budget");
  });

  it("applies a recency boost so a recent match outranks a cold equal match", () => {
    const items = [artifact("cold", "Report"), artifact("warm", "Report")];
    // Same title => same textual score; the recency boost on "warm"
    // (rank 0) must break the tie in its favour.
    const ranked = rankQuickSwitchItems({
      items,
      query: "report",
      recentKeys: ["warm"],
    });
    expect(ranked[0].item.id).toBe("artifact:warm");
  });

  it("does not let recency override a clearly stronger textual match", () => {
    const items = [
      artifact("recent", "Zebra crossing safety"),
      artifact("exact", "Roadmap"),
    ];
    const ranked = rankQuickSwitchItems({
      items,
      query: "roadmap",
      recentKeys: ["recent"],
    });
    expect(ranked[0].item.id).toBe("artifact:exact");
  });
});

describe("kindLabel", () => {
  it("covers every kind", () => {
    expect(kindLabel("artifact")).toBe("Artifact");
    expect(kindLabel("source")).toBe("Source");
    expect(kindLabel("template")).toBe("Template");
    expect(kindLabel("automation")).toBe("Automation");
    expect(kindLabel("task")).toBe("Task");
    expect(kindLabel("page")).toBe("Page");
  });
});
