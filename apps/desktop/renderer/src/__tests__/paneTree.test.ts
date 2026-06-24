import { describe, it, expect } from "vitest";
import {
  DEFAULT_PATH,
  MAX_LEAF_PANES,
  MAX_TABS_PER_PANE,
  MIN_PANE_FRACTION,
  WORKSPACE_SCHEMA_VERSION,
  closeOtherTabs,
  closeTab,
  closeTabsToRight,
  countLeaves,
  createDefaultWorkspace,
  deserializeWorkspace,
  equalizeSplits,
  findLeaf,
  focusAdjacentPane,
  focusAdjacentTab,
  focusPane,
  getActiveTab,
  getFocusedLeaf,
  listLeaves,
  listLinkedFollowers,
  maximizePane,
  moveTab,
  navigateTab,
  openTab,
  pruneStaleLinks,
  resizeSplit,
  resolveLinkedPath,
  restorePanes,
  serializeWorkspace,
  setActiveTab,
  setPaneLink,
  setPaneStacked,
  setTabScroll,
  splitPane,
  splitWithTab,
  tabTitleForPath,
  toggleMaximizePane,
  togglePaneStacked,
  wouldCreateLinkCycle,
  type LeafPane,
  type SplitPane,
  type WorkspaceState,
} from "../utils/paneTree";

function defaultWs(path = "/"): WorkspaceState {
  return createDefaultWorkspace({ paneId: "pane-1", tabId: "tab-1" }, path);
}

function asLeaf(state: WorkspaceState, id: string): LeafPane {
  const leaf = findLeaf(state.root, id);
  if (!leaf) throw new Error(`leaf ${id} not found`);
  return leaf;
}

/** Two side-by-side leaves: pane-1 (tab-1) | pane-2 (tab-2), focus pane-2. */
function twoPane(): WorkspaceState {
  return splitPane(defaultWs(), "pane-1", "row", {
    newPaneId: "pane-2",
    newTabId: "tab-2",
    newSplitId: "split-1",
  });
}

describe("paneTree — construction", () => {
  it("creates a single focused pane with one tab at the initial path", () => {
    const ws = defaultWs("/sources");
    expect(ws.root.type).toBe("leaf");
    const leaf = ws.root as LeafPane;
    expect(leaf.tabs).toHaveLength(1);
    expect(leaf.tabs[0].path).toBe("/sources");
    expect(leaf.activeTabId).toBe(leaf.tabs[0].id);
    expect(ws.focusedPaneId).toBe(leaf.id);
  });

  it("defaults to the Home path", () => {
    const ws = createDefaultWorkspace({ paneId: "p", tabId: "t" });
    expect((ws.root as LeafPane).tabs[0].path).toBe(DEFAULT_PATH);
  });
});

describe("paneTree — openTab", () => {
  it("appends and activates a new tab by default", () => {
    const ws = openTab(defaultWs(), "pane-1", { id: "t2", path: "/tasks" });
    const leaf = asLeaf(ws, "pane-1");
    expect(leaf.tabs.map((t) => t.path)).toEqual(["/", "/tasks"]);
    expect(leaf.activeTabId).toBe("t2");
    expect(ws.focusedPaneId).toBe("pane-1");
  });

  it("can open a background tab without activating it", () => {
    const ws = openTab(
      defaultWs(),
      "pane-1",
      { id: "t2", path: "/tasks" },
      { activate: false },
    );
    expect(asLeaf(ws, "pane-1").activeTabId).toBe("tab-1");
  });

  it("inserts at an explicit index", () => {
    let ws = openTab(defaultWs(), "pane-1", { id: "t2", path: "/a" });
    ws = openTab(ws, "pane-1", { id: "t3", path: "/b" }, { index: 1 });
    expect(asLeaf(ws, "pane-1").tabs.map((t) => t.id)).toEqual([
      "tab-1",
      "t3",
      "t2",
    ]);
  });

  it("no-ops on a missing pane or duplicate tab id", () => {
    const ws = defaultWs();
    expect(openTab(ws, "nope", { id: "x", path: "/" })).toBe(ws);
    expect(openTab(ws, "pane-1", { id: "tab-1", path: "/x" })).toBe(ws);
  });

  it("enforces the per-pane tab ceiling", () => {
    let ws = defaultWs();
    for (let i = 0; i < MAX_TABS_PER_PANE - 1; i++) {
      ws = openTab(ws, "pane-1", { id: `t${i}`, path: "/" });
    }
    expect(asLeaf(ws, "pane-1").tabs).toHaveLength(MAX_TABS_PER_PANE);
    const blocked = openTab(ws, "pane-1", { id: "overflow", path: "/" });
    expect(blocked).toBe(ws);
  });

  it("normalizes a path missing its leading slash", () => {
    const ws = openTab(defaultWs(), "pane-1", { id: "t2", path: "memory" });
    expect(asLeaf(ws, "pane-1").tabs[1].path).toBe("/memory");
  });
});

describe("paneTree — setActiveTab / navigateTab", () => {
  it("activates a tab and focuses its pane", () => {
    let ws = openTab(
      defaultWs(),
      "pane-1",
      { id: "t2", path: "/a" },
      { activate: false },
    );
    ws = setActiveTab(ws, "pane-1", "t2");
    expect(asLeaf(ws, "pane-1").activeTabId).toBe("t2");
  });

  it("navigateTab updates only the targeted tab path", () => {
    let ws = openTab(defaultWs(), "pane-1", { id: "t2", path: "/a" });
    ws = navigateTab(ws, "pane-1", "t2", "/b");
    const leaf = asLeaf(ws, "pane-1");
    expect(leaf.tabs.find((t) => t.id === "t2")!.path).toBe("/b");
    expect(leaf.tabs.find((t) => t.id === "tab-1")!.path).toBe("/");
  });

  it("navigateTab is a no-op (same reference) when the path is unchanged", () => {
    const ws = defaultWs();
    expect(navigateTab(ws, "pane-1", "tab-1", "/")).toBe(ws);
  });
});

describe("paneTree — closeTab", () => {
  it("removes a tab and moves active to the right neighbor", () => {
    let ws = openTab(defaultWs(), "pane-1", { id: "t2", path: "/a" });
    ws = openTab(ws, "pane-1", { id: "t3", path: "/b" });
    ws = setActiveTab(ws, "pane-1", "t2");
    ws = closeTab(ws, "pane-1", "t2");
    const leaf = asLeaf(ws, "pane-1");
    expect(leaf.tabs.map((t) => t.id)).toEqual(["tab-1", "t3"]);
    expect(leaf.activeTabId).toBe("t3");
  });

  it("falls back to the left neighbor when closing the last tab", () => {
    let ws = openTab(defaultWs(), "pane-1", { id: "t2", path: "/a" });
    ws = setActiveTab(ws, "pane-1", "t2");
    ws = closeTab(ws, "pane-1", "t2");
    expect(asLeaf(ws, "pane-1").activeTabId).toBe("tab-1");
  });

  it("refuses to close the only tab of the only pane", () => {
    const ws = defaultWs();
    expect(closeTab(ws, "pane-1", "tab-1")).toBe(ws);
  });

  it("collapses an emptied pane and merges its space back", () => {
    let ws = splitPane(defaultWs(), "pane-1", "row", {
      newPaneId: "pane-2",
      newTabId: "tab-2",
      newSplitId: "split-1",
    });
    expect(ws.root.type).toBe("split");
    expect(countLeaves(ws.root)).toBe(2);
    // Close the lone tab in pane-2 → pane collapses → back to one leaf.
    ws = closeTab(ws, "pane-2", "tab-2");
    expect(ws.root.type).toBe("leaf");
    expect((ws.root as LeafPane).id).toBe("pane-1");
    expect(ws.focusedPaneId).toBe("pane-1");
  });
});

describe("paneTree — focus", () => {
  it("focusPane moves focus and no-ops for missing panes", () => {
    let ws = splitPane(defaultWs(), "pane-1", "row", {
      newPaneId: "pane-2",
      newTabId: "tab-2",
      newSplitId: "split-1",
    });
    ws = focusPane(ws, "pane-1");
    expect(ws.focusedPaneId).toBe("pane-1");
    expect(focusPane(ws, "ghost")).toBe(ws);
  });

  it("focusAdjacentPane cycles across leaves", () => {
    let ws = splitPane(defaultWs(), "pane-1", "row", {
      newPaneId: "pane-2",
      newTabId: "tab-2",
      newSplitId: "split-1",
    });
    expect(ws.focusedPaneId).toBe("pane-2");
    ws = focusAdjacentPane(ws, "next");
    expect(ws.focusedPaneId).toBe("pane-1");
    ws = focusAdjacentPane(ws, "prev");
    expect(ws.focusedPaneId).toBe("pane-2");
  });

  it("focusAdjacentTab cycles within the focused pane", () => {
    let ws = openTab(defaultWs(), "pane-1", { id: "t2", path: "/a" });
    ws = setActiveTab(ws, "pane-1", "tab-1");
    ws = focusAdjacentTab(ws, "next");
    expect(getActiveTab(getFocusedLeaf(ws)).id).toBe("t2");
    ws = focusAdjacentTab(ws, "next");
    expect(getActiveTab(getFocusedLeaf(ws)).id).toBe("tab-1");
  });
});

describe("paneTree — splitPane", () => {
  it("splits a pane and clones the active path into the new pane", () => {
    const ws = splitPane(defaultWs("/sources"), "pane-1", "row", {
      newPaneId: "pane-2",
      newTabId: "tab-2",
      newSplitId: "split-1",
    });
    const split = ws.root as SplitPane;
    expect(split.type).toBe("split");
    expect(split.direction).toBe("row");
    expect(split.sizes).toEqual([0.5, 0.5]);
    const newLeaf = asLeaf(ws, "pane-2");
    expect(newLeaf.tabs[0].path).toBe("/sources");
    expect(ws.focusedPaneId).toBe("pane-2");
  });

  it("moves a specified tab into the new pane (split with tab)", () => {
    let ws = openTab(defaultWs(), "pane-1", { id: "t2", path: "/tasks" });
    ws = splitPane(
      ws,
      "pane-1",
      "column",
      { newPaneId: "pane-2", newTabId: "tab-x", newSplitId: "split-1" },
      { tabId: "t2" },
    );
    expect(asLeaf(ws, "pane-1").tabs.map((t) => t.id)).toEqual(["tab-1"]);
    expect(asLeaf(ws, "pane-2").tabs.map((t) => t.id)).toEqual(["t2"]);
  });

  it("clones instead of stranding when asked to split out the only tab", () => {
    const ws = splitPane(
      defaultWs("/memory"),
      "pane-1",
      "row",
      { newPaneId: "pane-2", newTabId: "tab-2", newSplitId: "split-1" },
      { tabId: "tab-1" },
    );
    expect(asLeaf(ws, "pane-1").tabs).toHaveLength(1);
    expect(asLeaf(ws, "pane-2").tabs[0].path).toBe("/memory");
  });

  it("merges a same-direction split rather than nesting it", () => {
    let ws = splitPane(defaultWs(), "pane-1", "row", {
      newPaneId: "pane-2",
      newTabId: "tab-2",
      newSplitId: "split-1",
    });
    ws = splitPane(ws, "pane-2", "row", {
      newPaneId: "pane-3",
      newTabId: "tab-3",
      newSplitId: "split-2",
    });
    const split = ws.root as SplitPane;
    expect(split.type).toBe("split");
    // Flattened to 3 side-by-side children, not a row-in-row.
    expect(split.children.map((c) => c.type)).toEqual(["leaf", "leaf", "leaf"]);
    expect(split.children).toHaveLength(3);
    expect(Math.abs(split.sizes.reduce((a, b) => a + b, 0) - 1)).toBeLessThan(
      1e-9,
    );
  });

  it("nests an opposite-direction split", () => {
    let ws = splitPane(defaultWs(), "pane-1", "row", {
      newPaneId: "pane-2",
      newTabId: "tab-2",
      newSplitId: "split-1",
    });
    ws = splitPane(ws, "pane-2", "column", {
      newPaneId: "pane-3",
      newTabId: "tab-3",
      newSplitId: "split-2",
    });
    const split = ws.root as SplitPane;
    expect(split.direction).toBe("row");
    const nested = split.children[1] as SplitPane;
    expect(nested.type).toBe("split");
    expect(nested.direction).toBe("column");
  });

  it("enforces the leaf-pane ceiling", () => {
    let ws = defaultWs();
    let n = 1;
    while (countLeaves(ws.root) < MAX_LEAF_PANES) {
      const focus = ws.focusedPaneId;
      ws = splitPane(ws, focus, "row", {
        newPaneId: `pane-extra-${n}`,
        newTabId: `tab-extra-${n}`,
        newSplitId: `split-extra-${n}`,
      });
      n++;
    }
    expect(countLeaves(ws.root)).toBe(MAX_LEAF_PANES);
    const blocked = splitPane(ws, ws.focusedPaneId, "row", {
      newPaneId: "too-many",
      newTabId: "too-many-tab",
      newSplitId: "too-many-split",
    });
    expect(blocked).toBe(ws);
  });
});

describe("paneTree — moveTab", () => {
  function twoPane(): WorkspaceState {
    let ws = openTab(defaultWs(), "pane-1", { id: "t2", path: "/a" });
    ws = splitPane(ws, "pane-1", "row", {
      newPaneId: "pane-2",
      newTabId: "tab-2",
      newSplitId: "split-1",
    });
    return ws;
  }

  it("reorders within a pane", () => {
    let ws = openTab(defaultWs(), "pane-1", { id: "t2", path: "/a" });
    ws = openTab(ws, "pane-1", { id: "t3", path: "/b" });
    ws = moveTab(
      ws,
      { paneId: "pane-1", tabId: "t3" },
      { paneId: "pane-1", index: 0 },
    );
    expect(asLeaf(ws, "pane-1").tabs.map((t) => t.id)).toEqual([
      "t3",
      "tab-1",
      "t2",
    ]);
  });

  it("moves a tab to another pane and activates it there", () => {
    let ws = twoPane();
    ws = moveTab(
      ws,
      { paneId: "pane-1", tabId: "t2" },
      { paneId: "pane-2", index: 0 },
    );
    expect(asLeaf(ws, "pane-1").tabs.map((t) => t.id)).toEqual(["tab-1"]);
    const dest = asLeaf(ws, "pane-2");
    expect(dest.tabs.map((t) => t.id)).toEqual(["t2", "tab-2"]);
    expect(dest.activeTabId).toBe("t2");
    expect(ws.focusedPaneId).toBe("pane-2");
  });

  it("collapses the source pane when its last tab moves out", () => {
    let ws = twoPane();
    // pane-2 has a single tab (tab-2). Move it into pane-1 → pane-2 collapses.
    ws = moveTab(
      ws,
      { paneId: "pane-2", tabId: "tab-2" },
      { paneId: "pane-1", index: 0 },
    );
    expect(ws.root.type).toBe("leaf");
    expect((ws.root as LeafPane).id).toBe("pane-1");
    expect(countLeaves(ws.root)).toBe(1);
  });

  it("no-ops for unknown tabs/panes and full destinations", () => {
    const ws = twoPane();
    expect(
      moveTab(
        ws,
        { paneId: "pane-1", tabId: "ghost" },
        { paneId: "pane-2", index: 0 },
      ),
    ).toBe(ws);
  });
});

describe("paneTree — resizeSplit", () => {
  it("applies clamped, renormalized sizes", () => {
    let ws = splitPane(defaultWs(), "pane-1", "row", {
      newPaneId: "pane-2",
      newTabId: "tab-2",
      newSplitId: "split-1",
    });
    ws = resizeSplit(ws, "split-1", [0.8, 0.2]);
    const split = ws.root as SplitPane;
    expect(split.sizes[0]).toBeCloseTo(0.8, 5);
    expect(split.sizes[1]).toBeCloseTo(0.2, 5);
  });

  it("never shrinks a pane below the minimum fraction", () => {
    let ws = splitPane(defaultWs(), "pane-1", "row", {
      newPaneId: "pane-2",
      newTabId: "tab-2",
      newSplitId: "split-1",
    });
    ws = resizeSplit(ws, "split-1", [0.999, 0.001]);
    const split = ws.root as SplitPane;
    expect(split.sizes[1]).toBeGreaterThanOrEqual(MIN_PANE_FRACTION - 1e-9);
    expect(split.sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
  });

  it("no-ops on wrong-length sizes or missing split", () => {
    const ws = splitPane(defaultWs(), "pane-1", "row", {
      newPaneId: "pane-2",
      newTabId: "tab-2",
      newSplitId: "split-1",
    });
    expect(resizeSplit(ws, "split-1", [1])).toBe(ws);
    expect(resizeSplit(ws, "ghost", [0.5, 0.5])).toBe(ws);
  });
});

describe("paneTree — persistence round-trip", () => {
  it("serializes and deserializes a complex layout losslessly", () => {
    let ws = openTab(defaultWs("/sources"), "pane-1", {
      id: "t2",
      path: "/tasks",
    });
    ws = splitPane(ws, "pane-1", "row", {
      newPaneId: "pane-2",
      newTabId: "tab-2",
      newSplitId: "split-1",
    });
    ws = splitPane(ws, "pane-2", "column", {
      newPaneId: "pane-3",
      newTabId: "tab-3",
      newSplitId: "split-2",
    });
    const round = deserializeWorkspace(serializeWorkspace(ws));
    expect(round).not.toBeNull();
    expect(round).toEqual(ws);
  });

  it("returns null for absent / non-JSON / wrong-version blobs", () => {
    expect(deserializeWorkspace(null)).toBeNull();
    expect(deserializeWorkspace("")).toBeNull();
    expect(deserializeWorkspace("{not json")).toBeNull();
    expect(
      deserializeWorkspace(JSON.stringify({ version: 999, state: {} })),
    ).toBeNull();
  });

  it("rejects structurally corrupt trees (empty leaf, dup ids, bad split)", () => {
    const emptyLeaf = {
      version: WORKSPACE_SCHEMA_VERSION,
      state: {
        focusedPaneId: "p",
        root: { type: "leaf", id: "p", tabs: [], activeTabId: "x" },
      },
    };
    expect(deserializeWorkspace(JSON.stringify(emptyLeaf))).toBeNull();

    const dupIds = {
      version: WORKSPACE_SCHEMA_VERSION,
      state: {
        focusedPaneId: "p",
        root: {
          type: "split",
          id: "p",
          direction: "row",
          sizes: [0.5, 0.5],
          children: [
            {
              type: "leaf",
              id: "dup",
              tabs: [{ id: "a", path: "/" }],
              activeTabId: "a",
            },
            {
              type: "leaf",
              id: "dup",
              tabs: [{ id: "b", path: "/" }],
              activeTabId: "b",
            },
          ],
        },
      },
    };
    expect(deserializeWorkspace(JSON.stringify(dupIds))).toBeNull();

    const badType = {
      version: WORKSPACE_SCHEMA_VERSION,
      state: { focusedPaneId: "p", root: { type: "wat", id: "p" } },
    };
    expect(deserializeWorkspace(JSON.stringify(badType))).toBeNull();
  });

  it("repairs a stale focus id to an existing leaf", () => {
    const blob = {
      version: WORKSPACE_SCHEMA_VERSION,
      state: {
        focusedPaneId: "does-not-exist",
        root: {
          type: "leaf",
          id: "real",
          tabs: [{ id: "a", path: "/" }],
          activeTabId: "a",
        },
      },
    };
    const ws = deserializeWorkspace(JSON.stringify(blob));
    expect(ws).not.toBeNull();
    expect(ws!.focusedPaneId).toBe("real");
  });

  it("repairs an out-of-range activeTabId to the first tab", () => {
    const blob = {
      version: WORKSPACE_SCHEMA_VERSION,
      state: {
        focusedPaneId: "real",
        root: {
          type: "leaf",
          id: "real",
          tabs: [
            { id: "a", path: "/" },
            { id: "b", path: "/tasks" },
          ],
          activeTabId: "ghost",
        },
      },
    };
    const ws = deserializeWorkspace(JSON.stringify(blob));
    expect((ws!.root as LeafPane).activeTabId).toBe("a");
  });

  it("flattens a persisted single-child split", () => {
    const blob = {
      version: WORKSPACE_SCHEMA_VERSION,
      state: {
        focusedPaneId: "leaf",
        root: {
          type: "split",
          id: "s",
          direction: "row",
          sizes: [1],
          children: [
            {
              type: "leaf",
              id: "leaf",
              tabs: [{ id: "a", path: "/" }],
              activeTabId: "a",
            },
          ],
        },
      },
    };
    const ws = deserializeWorkspace(JSON.stringify(blob));
    expect(ws!.root.type).toBe("leaf");
  });
});

describe("paneTree — tabTitleForPath", () => {
  it("maps known routes to readable labels", () => {
    expect(tabTitleForPath("/")).toBe("Home");
    expect(tabTitleForPath("/sources")).toBe("Sources");
    expect(tabTitleForPath("/sources/abc-123")).toBe("Source");
    expect(tabTitleForPath("/templates")).toBe("Templates");
    expect(tabTitleForPath("/tasks")).toBe("Tasks");
    expect(tabTitleForPath("/automations")).toBe("Automations");
    expect(tabTitleForPath("/vision")).toBe("Vision");
    expect(tabTitleForPath("/memory")).toBe("Memory");
    expect(tabTitleForPath("/settings#appearance")).toBe("Settings");
    expect(tabTitleForPath("/artifacts/xyz/edit")).toBe("Artifact");
  });

  it("strips query/hash and handles unknown routes", () => {
    expect(tabTitleForPath("/sources#connectors")).toBe("Sources");
    expect(tabTitleForPath("/widgets")).toBe("Widgets");
  });
});

describe("paneTree — immutability", () => {
  it("never mutates the input state", () => {
    const ws = defaultWs();
    const snapshot = JSON.parse(JSON.stringify(ws));
    openTab(ws, "pane-1", { id: "t2", path: "/a" });
    splitPane(ws, "pane-1", "row", {
      newPaneId: "p2",
      newTabId: "t2",
      newSplitId: "s1",
    });
    expect(ws).toEqual(snapshot);
  });

  it("returns an untouched branch by reference identity", () => {
    let ws = splitPane(defaultWs(), "pane-1", "row", {
      newPaneId: "pane-2",
      newTabId: "tab-2",
      newSplitId: "split-1",
    });
    const before = (ws.root as SplitPane).children[0];
    ws = openTab(ws, "pane-2", { id: "t-extra", path: "/tasks" });
    const after = (ws.root as SplitPane).children[0];
    expect(after).toBe(before);
    expect(listLeaves(ws.root)).toHaveLength(2);
  });
});

describe("paneTree — scroll persistence", () => {
  it("records a finite, non-negative scrollTop on the active tab", () => {
    const ws = setTabScroll(defaultWs(), "pane-1", "tab-1", 240.6);
    expect(asLeaf(ws, "pane-1").tabs[0].scrollTop).toBe(241);
  });

  it("clamps negatives to zero and ignores non-finite values", () => {
    // Clamp a previously-set offset back down to 0.
    let ws = setTabScroll(defaultWs(), "pane-1", "tab-1", 80);
    ws = setTabScroll(ws, "pane-1", "tab-1", -5);
    expect(asLeaf(ws, "pane-1").tabs[0].scrollTop).toBe(0);
    const fresh = defaultWs();
    expect(setTabScroll(fresh, "pane-1", "tab-1", Number.NaN)).toBe(fresh);
    expect(setTabScroll(fresh, "pane-1", "tab-1", Infinity)).toBe(fresh);
  });

  it("no-ops (same reference) when the value is unchanged or target missing", () => {
    const ws = setTabScroll(defaultWs(), "pane-1", "tab-1", 100);
    expect(setTabScroll(ws, "pane-1", "tab-1", 100)).toBe(ws);
    expect(setTabScroll(ws, "ghost", "tab-1", 50)).toBe(ws);
    expect(setTabScroll(ws, "pane-1", "ghost", 50)).toBe(ws);
  });

  it("clears scrollTop when the tab navigates to a new path", () => {
    let ws = setTabScroll(defaultWs(), "pane-1", "tab-1", 120);
    expect(asLeaf(ws, "pane-1").tabs[0].scrollTop).toBe(120);
    ws = navigateTab(ws, "pane-1", "tab-1", "/tasks");
    expect(asLeaf(ws, "pane-1").tabs[0].scrollTop).toBeUndefined();
  });

  it("round-trips scrollTop through serialize/deserialize", () => {
    const ws = setTabScroll(defaultWs(), "pane-1", "tab-1", 333);
    const restored = deserializeWorkspace(serializeWorkspace(ws));
    expect(asLeaf(restored!, "pane-1").tabs[0].scrollTop).toBe(333);
  });

  it("tolerates a bad scrollTop in a persisted blob (drops it, keeps layout)", () => {
    const blob = {
      version: WORKSPACE_SCHEMA_VERSION,
      state: {
        focusedPaneId: "leaf",
        root: {
          type: "leaf",
          id: "leaf",
          tabs: [{ id: "a", path: "/", scrollTop: "nope" }],
          activeTabId: "a",
        },
      },
    };
    const ws = deserializeWorkspace(JSON.stringify(blob));
    expect(ws).not.toBeNull();
    expect((ws!.root as LeafPane).tabs[0].scrollTop).toBeUndefined();
  });
});

describe("paneTree — maximize / restore", () => {
  it("maximizes a live pane and focuses it", () => {
    let ws = twoPane();
    ws = maximizePane(ws, "pane-1");
    expect(ws.maximizedPaneId).toBe("pane-1");
    expect(ws.focusedPaneId).toBe("pane-1");
  });

  it("no-ops maximize on a missing pane", () => {
    const ws = twoPane();
    expect(maximizePane(ws, "ghost")).toBe(ws);
  });

  it("restore clears the flag; toggle flips it", () => {
    let ws = maximizePane(twoPane(), "pane-2");
    ws = restorePanes(ws);
    expect(ws.maximizedPaneId).toBeUndefined();
    ws = toggleMaximizePane(ws, "pane-2");
    expect(ws.maximizedPaneId).toBe("pane-2");
    ws = toggleMaximizePane(ws, "pane-2");
    expect(ws.maximizedPaneId).toBeUndefined();
  });

  it("auto-clears the maximize flag when the maximized pane collapses", () => {
    let ws = maximizePane(twoPane(), "pane-2");
    expect(ws.maximizedPaneId).toBe("pane-2");
    // Closing pane-2's only tab collapses it back to a single leaf.
    ws = closeTab(ws, "pane-2", "tab-2");
    expect(ws.maximizedPaneId).toBeUndefined();
    expect(ws.root.type).toBe("leaf");
  });

  it("preserves the maximize flag across a tab open in another pane", () => {
    let ws = maximizePane(twoPane(), "pane-1");
    ws = openTab(ws, "pane-2", { id: "t-extra", path: "/tasks" });
    expect(ws.maximizedPaneId).toBe("pane-1");
  });

  it("does not survive serialize when the pane is gone", () => {
    const blob = {
      version: WORKSPACE_SCHEMA_VERSION,
      state: {
        focusedPaneId: "leaf",
        maximizedPaneId: "ghost",
        root: {
          type: "leaf",
          id: "leaf",
          tabs: [{ id: "a", path: "/" }],
          activeTabId: "a",
        },
      },
    };
    const ws = deserializeWorkspace(JSON.stringify(blob));
    expect(ws!.maximizedPaneId).toBeUndefined();
  });

  it("restores a valid maximize flag from a persisted blob", () => {
    const ws = deserializeWorkspace(
      serializeWorkspace(maximizePane(twoPane(), "pane-1")),
    );
    expect(ws!.maximizedPaneId).toBe("pane-1");
  });
});

describe("paneTree — equalizeSplits", () => {
  it("rebalances an uneven split to equal fractions", () => {
    let ws = twoPane();
    ws = resizeSplit(ws, "split-1", [0.8, 0.2]);
    expect((ws.root as SplitPane).sizes).toEqual([0.8, 0.2]);
    ws = equalizeSplits(ws);
    expect((ws.root as SplitPane).sizes).toEqual([0.5, 0.5]);
  });

  it("no-ops (same reference) on a single pane or already-even tree", () => {
    const single = defaultWs();
    expect(equalizeSplits(single)).toBe(single);
    const even = twoPane();
    expect(equalizeSplits(even)).toBe(even);
  });
});

describe("paneTree — closeOtherTabs / closeTabsToRight", () => {
  function fourTabs(): WorkspaceState {
    let ws = openTab(defaultWs(), "pane-1", { id: "t2", path: "/a" });
    ws = openTab(ws, "pane-1", { id: "t3", path: "/b" });
    ws = openTab(ws, "pane-1", { id: "t4", path: "/c" });
    return ws;
  }

  it("closeOtherTabs keeps only the named tab and activates it", () => {
    const ws = closeOtherTabs(fourTabs(), "pane-1", "t3");
    const leaf = asLeaf(ws, "pane-1");
    expect(leaf.tabs.map((t) => t.id)).toEqual(["t3"]);
    expect(leaf.activeTabId).toBe("t3");
  });

  it("closeOtherTabs no-ops on a single-tab pane or missing tab", () => {
    const single = defaultWs();
    expect(closeOtherTabs(single, "pane-1", "tab-1")).toBe(single);
    const four = fourTabs();
    expect(closeOtherTabs(four, "pane-1", "ghost")).toBe(four);
  });

  it("closeTabsToRight removes trailing tabs and repairs active id", () => {
    let ws = fourTabs(); // active = t4 (last opened)
    ws = closeTabsToRight(ws, "pane-1", "t2");
    const leaf = asLeaf(ws, "pane-1");
    expect(leaf.tabs.map((t) => t.id)).toEqual(["tab-1", "t2"]);
    // t4 was active and got removed → falls back to the boundary tab.
    expect(leaf.activeTabId).toBe("t2");
  });

  it("closeTabsToRight keeps an active tab that survives", () => {
    let ws = fourTabs();
    ws = setActiveTab(ws, "pane-1", "tab-1");
    ws = closeTabsToRight(ws, "pane-1", "t2");
    expect(asLeaf(ws, "pane-1").activeTabId).toBe("tab-1");
  });

  it("closeTabsToRight no-ops when the tab is already last", () => {
    const four = fourTabs();
    expect(closeTabsToRight(four, "pane-1", "t4")).toBe(four);
  });
});

describe("paneTree — splitWithTab (drag-to-split)", () => {
  it("moves a tab into a new pane on the trailing side of the target", () => {
    let ws = openTab(defaultWs(), "pane-1", { id: "t2", path: "/a" });
    ws = splitWithTab(ws, { paneId: "pane-1", tabId: "t2" }, "pane-1", "row", {
      newPaneId: "p2",
      newTabId: "ignored",
      newSplitId: "s1",
    });
    // Same pane with >1 tab falls back to splitPane carving t2 out.
    expect(countLeaves(ws.root)).toBe(2);
    const moved = listLeaves(ws.root).find((l) =>
      l.tabs.some((t) => t.id === "t2"),
    );
    expect(moved).toBeTruthy();
  });

  it("moves a tab from one pane into a new split of another", () => {
    let ws = twoPane(); // pane-1 | pane-2
    ws = openTab(ws, "pane-1", { id: "t1b", path: "/a" });
    ws = splitWithTab(
      ws,
      { paneId: "pane-1", tabId: "t1b" },
      "pane-2",
      "column",
      { newPaneId: "p3", newTabId: "x", newSplitId: "s2" },
      { before: false },
    );
    expect(countLeaves(ws.root)).toBe(3);
    expect(asLeaf(ws, "p3").tabs.map((t) => t.id)).toEqual(["t1b"]);
    expect(ws.focusedPaneId).toBe("p3");
    // pane-1 retains its remaining tab.
    expect(asLeaf(ws, "pane-1").tabs.map((t) => t.id)).toEqual(["tab-1"]);
  });

  it("no-ops at the leaf ceiling and for missing source/target", () => {
    const ws = twoPane();
    expect(
      splitWithTab(ws, { paneId: "ghost", tabId: "x" }, "pane-2", "row", {
        newPaneId: "p",
        newTabId: "t",
        newSplitId: "s",
      }),
    ).toBe(ws);
    expect(
      splitWithTab(ws, { paneId: "pane-1", tabId: "tab-1" }, "ghost", "row", {
        newPaneId: "p",
        newTabId: "t",
        newSplitId: "s",
      }),
    ).toBe(ws);
  });
});

describe("paneTree — stacked tabs", () => {
  it("sets and clears the stacked flag, dropping it when false", () => {
    let ws = setPaneStacked(defaultWs(), "pane-1", true);
    expect(asLeaf(ws, "pane-1").stacked).toBe(true);
    ws = setPaneStacked(ws, "pane-1", false);
    expect("stacked" in asLeaf(ws, "pane-1")).toBe(false);
  });

  it("toggle flips the flag and no-ops on missing pane", () => {
    const ws = togglePaneStacked(defaultWs(), "pane-1");
    expect(asLeaf(ws, "pane-1").stacked).toBe(true);
    expect(togglePaneStacked(ws, "ghost")).toBe(ws);
  });

  it("round-trips the stacked flag through persistence", () => {
    const ws = setPaneStacked(defaultWs(), "pane-1", true);
    const restored = deserializeWorkspace(serializeWorkspace(ws));
    expect(asLeaf(restored!, "pane-1").stacked).toBe(true);
  });
});

describe("paneTree — linked panes", () => {
  it("links a follower to a leader and resolves the leader's path", () => {
    let ws = twoPane();
    ws = navigateTab(ws, "pane-1", "tab-1", "/sources");
    ws = setPaneLink(ws, "pane-2", "pane-1");
    expect(asLeaf(ws, "pane-2").followPaneId).toBe("pane-1");
    expect(resolveLinkedPath(ws, "pane-2")).toBe("/sources");
    expect(resolveLinkedPath(ws, "pane-1")).toBeNull();
  });

  it("follows the leader's active tab as it changes", () => {
    let ws = twoPane();
    ws = openTab(ws, "pane-1", { id: "t1b", path: "/tasks" });
    ws = setPaneLink(ws, "pane-2", "pane-1");
    expect(resolveLinkedPath(ws, "pane-2")).toBe("/tasks");
    ws = setActiveTab(ws, "pane-1", "tab-1");
    expect(resolveLinkedPath(ws, "pane-2")).toBe("/");
  });

  it("rejects self-links and cycles", () => {
    let ws = twoPane();
    expect(setPaneLink(ws, "pane-1", "pane-1")).toBe(ws);
    expect(wouldCreateLinkCycle(ws, "pane-1", "pane-1")).toBe(true);
    ws = setPaneLink(ws, "pane-2", "pane-1");
    // pane-1 following pane-2 would close the loop.
    expect(wouldCreateLinkCycle(ws, "pane-1", "pane-2")).toBe(true);
    expect(setPaneLink(ws, "pane-1", "pane-2")).toBe(ws);
  });

  it("clears a link with null and lists followers", () => {
    let ws = setPaneLink(twoPane(), "pane-2", "pane-1");
    expect(listLinkedFollowers(ws.root, "pane-1").map((l) => l.id)).toEqual([
      "pane-2",
    ]);
    ws = setPaneLink(ws, "pane-2", null);
    expect(asLeaf(ws, "pane-2").followPaneId).toBeUndefined();
    expect(listLinkedFollowers(ws.root, "pane-1")).toHaveLength(0);
  });

  it("prunes a dangling link when the leader pane collapses", () => {
    let ws = twoPane();
    ws = setPaneLink(ws, "pane-1", "pane-2");
    expect(asLeaf(ws, "pane-1").followPaneId).toBe("pane-2");
    // Collapse pane-2 (close its only tab) → pane-1's link is pruned.
    ws = closeTab(ws, "pane-2", "tab-2");
    expect(ws.root.type).toBe("leaf");
    expect((ws.root as LeafPane).followPaneId).toBeUndefined();
  });

  it("pruneStaleLinks is a no-op when all links are live", () => {
    const ws = setPaneLink(twoPane(), "pane-2", "pane-1");
    expect(pruneStaleLinks(ws)).toBe(ws);
  });

  it("drops a dangling follow link on deserialize", () => {
    const blob = {
      version: WORKSPACE_SCHEMA_VERSION,
      state: {
        focusedPaneId: "leaf",
        root: {
          type: "leaf",
          id: "leaf",
          tabs: [{ id: "a", path: "/" }],
          activeTabId: "a",
          followPaneId: "missing",
        },
      },
    };
    const ws = deserializeWorkspace(JSON.stringify(blob));
    expect((ws!.root as LeafPane).followPaneId).toBeUndefined();
  });
});
