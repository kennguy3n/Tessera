/**
 * Pure layout logic for the split-pane / tabbed workspace.
 *
 * This module is the single source of truth for the workspace's shape
 * and every mutation that can be performed on it. It is deliberately
 * free of React, of the `window.tessera` bridge, and of any I/O so the
 * non-trivial tree algebra (open / close / move / split / collapse /
 * resize a pane tree, plus defensive (de)serialization of persisted
 * layout) is unit-testable in isolation — mirroring how
 * `utils/conceptGraph.ts` holds the pure logic for `ConceptGraphPanel`.
 *
 * The renderer components (`WorkspaceProvider`, `WorkspaceView`,
 * `Pane`, `TabStrip`, `PaneSplitter`) are a thin shell over these
 * helpers: they generate ids, render the tree, and translate user
 * gestures into calls here.
 *
 * ## The model
 *
 * The layout is a small typed tree:
 *
 *   - a **leaf** ({@link LeafPane}) is a single pane: an ordered list
 *     of tabs plus the id of the active one. Each tab carries only a
 *     route `path` string and a stable id.
 *   - a **split** ({@link SplitPane}) is a branch: a direction
 *     (`row` = side-by-side, `column` = stacked), an ordered list of
 *     child nodes, and a parallel `sizes` array of fractions (each in
 *     `(0, 1)`, summing to 1) giving each child's share of the axis.
 *
 * Invariants enforced by every constructor/mutation and re-checked on
 * deserialize:
 *   - a leaf always has ≥1 tab and its `activeTabId` references one of
 *     them;
 *   - a split always has ≥2 children (single-child splits are
 *     flattened) and `sizes.length === children.length` with a
 *     positive sum;
 *   - nested splits of the *same* direction are merged so the tree is
 *     canonical (no `row` directly inside `row`);
 *   - exactly one `focusedPaneId`, always referencing an existing leaf.
 *
 * All functions are pure: they never mutate their input and return a
 * new state (or the same reference when nothing changed). Operations
 * that create nodes take the new ids as explicit arguments so the
 * logic stays deterministic and testable — the React layer supplies
 * `crypto.randomUUID()` values.
 */

/** Default route a fresh tab points at (the Home page). */
export const DEFAULT_PATH = "/";

/**
 * Upper bound on tabs in a single pane. A generous ceiling that keeps
 * a runaway "open in new tab" loop (or a corrupt persisted layout)
 * from spawning an unbounded strip; `openTab` / `moveTab` no-op once
 * a pane is full.
 */
export const MAX_TABS_PER_PANE = 24;

/**
 * Upper bound on the number of leaf panes in the whole workspace.
 * `splitPane` no-ops once reached. Bounds both render cost (each
 * visible pane mounts a router + page) and the persisted blob size.
 */
export const MAX_LEAF_PANES = 8;

/**
 * Smallest fraction a pane is allowed to shrink to when resizing, so
 * a splitter drag can never collapse a pane to zero width/height and
 * strand its content.
 */
export const MIN_PANE_FRACTION = 0.1;

/** Direction of a split: `row` = side-by-side, `column` = stacked. */
export type SplitDirection = "row" | "column";

/** A single tab: a stable id plus the route path it renders. */
export interface WorkspaceTab {
  readonly id: string;
  /** Route location string, e.g. `"/sources"` or `"/sources/abc#x"`. */
  readonly path: string;
}

/** A leaf pane: an ordered tab list and the active tab's id. */
export interface LeafPane {
  readonly type: "leaf";
  readonly id: string;
  readonly tabs: readonly WorkspaceTab[];
  readonly activeTabId: string;
}

/** A split branch: a direction, ordered children, and their sizes. */
export interface SplitPane {
  readonly type: "split";
  readonly id: string;
  readonly direction: SplitDirection;
  readonly children: readonly WorkspaceNode[];
  /** Parallel to `children`; fractions in `(0,1)` summing to 1. */
  readonly sizes: readonly number[];
}

export type WorkspaceNode = LeafPane | SplitPane;

export interface WorkspaceState {
  readonly root: WorkspaceNode;
  readonly focusedPaneId: string;
}

/** Ids needed to create a fresh single-pane workspace. */
export interface WorkspaceSeedIds {
  readonly paneId: string;
  readonly tabId: string;
}

/** Ids needed to split a pane (a new pane, its first tab, and — when
 *  the source pane must be wrapped — a new split node). */
export interface SplitIds {
  readonly newPaneId: string;
  readonly newTabId: string;
  readonly newSplitId: string;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * Build the default workspace: one pane, one tab pointing at
 * `initialPath`, focused. This is the first-run layout and the
 * fallback whenever a persisted layout is missing or corrupt, so the
 * app behaves exactly like the pre-workspace single-pane shell.
 */
export function createDefaultWorkspace(
  ids: WorkspaceSeedIds,
  initialPath: string = DEFAULT_PATH,
): WorkspaceState {
  const tab: WorkspaceTab = { id: ids.tabId, path: normalizePath(initialPath) };
  const leaf: LeafPane = {
    type: "leaf",
    id: ids.paneId,
    tabs: [tab],
    activeTabId: tab.id,
  };
  return { root: leaf, focusedPaneId: leaf.id };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Collect every leaf pane in left-to-right, top-to-bottom (document)
 *  order. Used for tab/pane cycling and focus repair. */
export function listLeaves(node: WorkspaceNode): LeafPane[] {
  if (node.type === "leaf") return [node];
  const out: LeafPane[] = [];
  for (const child of node.children) out.push(...listLeaves(child));
  return out;
}

/** Number of leaf panes in the tree. */
export function countLeaves(node: WorkspaceNode): number {
  if (node.type === "leaf") return 1;
  return node.children.reduce((n, c) => n + countLeaves(c), 0);
}

/** Find a leaf by id, or `null`. */
export function findLeaf(
  node: WorkspaceNode,
  paneId: string,
): LeafPane | null {
  if (node.type === "leaf") return node.id === paneId ? node : null;
  for (const child of node.children) {
    const found = findLeaf(child, paneId);
    if (found) return found;
  }
  return null;
}

/** The focused leaf, falling back to the first leaf if the focus id
 *  has gone stale (should not happen given the invariants, but keeps
 *  callers total). */
export function getFocusedLeaf(state: WorkspaceState): LeafPane {
  return findLeaf(state.root, state.focusedPaneId) ?? listLeaves(state.root)[0];
}

/** The active tab of a leaf (falls back to the first tab). */
export function getActiveTab(leaf: LeafPane): WorkspaceTab {
  return leaf.tabs.find((t) => t.id === leaf.activeTabId) ?? leaf.tabs[0];
}

// ---------------------------------------------------------------------------
// Internal tree helpers
// ---------------------------------------------------------------------------

/**
 * Rebuild the tree, replacing the leaf with id `paneId` by
 * `updater(leaf)`. Returning `null` removes the leaf (and collapses
 * now-empty / single-child splits); returning a node (leaf or split)
 * substitutes it. Untouched branches keep their reference identity so
 * React can bail out of re-rendering them.
 */
function rebuild(
  node: WorkspaceNode,
  paneId: string,
  updater: (leaf: LeafPane) => WorkspaceNode | null,
): WorkspaceNode | null {
  if (node.type === "leaf") {
    return node.id === paneId ? updater(node) : node;
  }
  const nextChildren: WorkspaceNode[] = [];
  const nextSizes: number[] = [];
  let changed = false;
  node.children.forEach((child, i) => {
    const res = rebuild(child, paneId, updater);
    if (res === null) {
      changed = true;
      return;
    }
    if (res !== child) changed = true;
    nextChildren.push(res);
    nextSizes.push(node.sizes[i] ?? 1 / node.children.length);
  });
  if (!changed) return node;
  if (nextChildren.length === 0) return null;
  if (nextChildren.length === 1) return nextChildren[0];
  return {
    ...node,
    children: nextChildren,
    sizes: normalizeSizes(nextSizes),
  };
}

/**
 * Canonicalize a tree: flatten single-child splits and merge a split
 * into a parent of the same direction (hoisting its children with
 * their sizes scaled by the slot they occupied). Keeps the tree free
 * of `row`-in-`row` / `column`-in-`column` nesting so resize handles
 * and rendering stay flat and predictable.
 */
function normalizeTree(node: WorkspaceNode): WorkspaceNode {
  if (node.type === "leaf") return node;
  const normalizedChildren = node.children.map(normalizeTree);
  const children: WorkspaceNode[] = [];
  const sizes: number[] = [];
  normalizedChildren.forEach((child, i) => {
    const slot = node.sizes[i] ?? 1 / normalizedChildren.length;
    if (child.type === "split" && child.direction === node.direction) {
      // Merge: hoist grandchildren, scaling their fractions into the
      // slot the nested split occupied.
      child.children.forEach((gc, j) => {
        children.push(gc);
        sizes.push(slot * (child.sizes[j] ?? 1 / child.children.length));
      });
    } else {
      children.push(child);
      sizes.push(slot);
    }
  });
  if (children.length === 1) return children[0];
  return { ...node, direction: node.direction, children, sizes: normalizeSizes(sizes) };
}

/**
 * Normalize fractions to sum to 1 while guaranteeing every entry is at
 * least {@link MIN_PANE_FRACTION}, via constrained "water-filling":
 * entries that fall below the floor are pinned to it and the remaining
 * budget is redistributed proportionally among the rest (repeating
 * until stable). This keeps a splitter drag from ever starving a pane
 * to zero, regardless of the raw fractions the caller supplies. Falls
 * back to an equal split for degenerate input.
 */
function clampSizesWithMin(sizes: readonly number[]): number[] {
  const n = sizes.length;
  if (n === 0) return [];
  // If the floor can't fit (too many panes), just split equally.
  if (MIN_PANE_FRACTION * n >= 1) return sizes.map(() => 1 / n);
  let weights = normalizeSizes(sizes);
  const pinned = new Array<boolean>(n).fill(false);
  // At most `n` passes: each pass pins at least one more entry.
  for (let pass = 0; pass < n; pass++) {
    const pinnedTotal = pinned.reduce(
      (acc, isPinned) => acc + (isPinned ? MIN_PANE_FRACTION : 0),
      0,
    );
    const freeBudget = 1 - pinnedTotal;
    const freeWeightSum = weights.reduce(
      (acc, w, i) => acc + (pinned[i] ? 0 : w),
      0,
    );
    const next = weights.map((w, i) => {
      if (pinned[i]) return MIN_PANE_FRACTION;
      return freeWeightSum > 0 ? (w / freeWeightSum) * freeBudget : 0;
    });
    let pinnedAny = false;
    for (let i = 0; i < n; i++) {
      if (!pinned[i] && next[i] < MIN_PANE_FRACTION) {
        pinned[i] = true;
        pinnedAny = true;
      }
    }
    weights = next;
    if (!pinnedAny) break;
  }
  return weights;
}

/** Scale a list of fractions to sum to 1; equal split if the sum is
 *  non-positive (degenerate input). */
function normalizeSizes(sizes: readonly number[]): number[] {
  const safe = sizes.map((s) => (Number.isFinite(s) && s > 0 ? s : 0));
  const sum = safe.reduce((a, b) => a + b, 0);
  if (sum <= 0) return safe.map(() => 1 / safe.length);
  return safe.map((s) => s / sum);
}

/** Re-point focus at an existing leaf if the current focus id is
 *  stale. Prefers leaving focus unchanged. */
function ensureFocus(
  root: WorkspaceNode,
  focusedPaneId: string,
): WorkspaceState {
  if (findLeaf(root, focusedPaneId)) return { root, focusedPaneId };
  const first = listLeaves(root)[0];
  return { root, focusedPaneId: first.id };
}

function withActiveTab(leaf: LeafPane, tabs: readonly WorkspaceTab[]): LeafPane {
  const activeStillThere = tabs.some((t) => t.id === leaf.activeTabId);
  return {
    ...leaf,
    tabs,
    activeTabId: activeStillThere ? leaf.activeTabId : tabs[0]?.id,
  };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Open `newTab` in the leaf `paneId`. By default the tab is appended
 * and activated; pass `index` to insert at a position and
 * `activate: false` to open it in the background. Focuses the pane.
 * No-ops if the pane is missing, the pane is full
 * ({@link MAX_TABS_PER_PANE}), or a tab with the same id already
 * exists.
 */
export function openTab(
  state: WorkspaceState,
  paneId: string,
  newTab: WorkspaceTab,
  opts: { activate?: boolean; index?: number } = {},
): WorkspaceState {
  const target = findLeaf(state.root, paneId);
  if (!target) return state;
  if (target.tabs.length >= MAX_TABS_PER_PANE) return state;
  if (target.tabs.some((t) => t.id === newTab.id)) return state;
  const activate = opts.activate ?? true;
  const tab: WorkspaceTab = { id: newTab.id, path: normalizePath(newTab.path) };
  const root = rebuild(state.root, paneId, (leaf) => {
    const tabs = [...leaf.tabs];
    const at = clampIndex(opts.index, tabs.length);
    tabs.splice(at, 0, tab);
    return { ...leaf, tabs, activeTabId: activate ? tab.id : leaf.activeTabId };
  });
  if (!root) return state;
  return { root, focusedPaneId: paneId };
}

/**
 * Close tab `tabId` in pane `paneId`. The active tab, if closed,
 * yields to its right neighbor (or left if it was last). Closing the
 * last tab in a pane collapses that pane and merges its space back
 * into the parent split, moving focus to an adjacent leaf. Closing
 * the very last tab in the entire workspace is a no-op — the
 * workspace always keeps at least one tab open (Obsidian behavior).
 */
export function closeTab(
  state: WorkspaceState,
  paneId: string,
  tabId: string,
): WorkspaceState {
  const target = findLeaf(state.root, paneId);
  if (!target) return state;
  if (!target.tabs.some((t) => t.id === tabId)) return state;
  const isOnlyTab = target.tabs.length === 1;
  const isOnlyLeaf = countLeaves(state.root) === 1;
  if (isOnlyTab && isOnlyLeaf) return state;

  const root = rebuild(state.root, paneId, (leaf) => {
    const idx = leaf.tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return leaf;
    const tabs = leaf.tabs.filter((t) => t.id !== tabId);
    if (tabs.length === 0) return null; // collapse this pane
    let activeTabId = leaf.activeTabId;
    if (leaf.activeTabId === tabId) {
      const next = leaf.tabs[idx + 1] ?? leaf.tabs[idx - 1];
      activeTabId = next.id;
    }
    return { ...leaf, tabs, activeTabId };
  });
  if (!root) return state;
  const normalized = normalizeTree(root);
  return ensureFocus(normalized, paneId);
}

/** Make `tabId` the active tab of pane `paneId` and focus the pane.
 *  No-ops if the pane or tab is missing. */
export function setActiveTab(
  state: WorkspaceState,
  paneId: string,
  tabId: string,
): WorkspaceState {
  const target = findLeaf(state.root, paneId);
  if (!target || !target.tabs.some((t) => t.id === tabId)) return state;
  if (target.activeTabId === tabId && state.focusedPaneId === paneId) {
    return state;
  }
  const root = rebuild(state.root, paneId, (leaf) => ({
    ...leaf,
    activeTabId: tabId,
  }));
  if (!root) return state;
  return { root, focusedPaneId: paneId };
}

/**
 * Update the `path` of a tab (its in-pane navigation). This is the
 * sink for a pane's router: when the user navigates inside a tab the
 * component reports the new location here so the layout — and the
 * persisted blob — stay in sync. No-ops (returns same reference) when
 * the path is unchanged so router→state sync can't loop.
 */
export function navigateTab(
  state: WorkspaceState,
  paneId: string,
  tabId: string,
  path: string,
): WorkspaceState {
  const next = normalizePath(path);
  const target = findLeaf(state.root, paneId);
  if (!target) return state;
  const tab = target.tabs.find((t) => t.id === tabId);
  if (!tab || tab.path === next) return state;
  const root = rebuild(state.root, paneId, (leaf) => ({
    ...leaf,
    tabs: leaf.tabs.map((t) => (t.id === tabId ? { ...t, path: next } : t)),
  }));
  if (!root) return state;
  return { ...state, root };
}

/** Move keyboard/UI focus to pane `paneId`. No-ops if missing. */
export function focusPane(
  state: WorkspaceState,
  paneId: string,
): WorkspaceState {
  if (state.focusedPaneId === paneId) return state;
  if (!findLeaf(state.root, paneId)) return state;
  return { ...state, focusedPaneId: paneId };
}

/** Cycle focus across leaf panes in document order. */
export function focusAdjacentPane(
  state: WorkspaceState,
  dir: "next" | "prev",
): WorkspaceState {
  const leaves = listLeaves(state.root);
  if (leaves.length < 2) return state;
  const i = leaves.findIndex((l) => l.id === state.focusedPaneId);
  const cur = i === -1 ? 0 : i;
  const delta = dir === "next" ? 1 : -1;
  const next = leaves[(cur + delta + leaves.length) % leaves.length];
  return { ...state, focusedPaneId: next.id };
}

/** Activate the next/previous tab within the focused pane (wraps). */
export function focusAdjacentTab(
  state: WorkspaceState,
  dir: "next" | "prev",
): WorkspaceState {
  const leaf = getFocusedLeaf(state);
  if (leaf.tabs.length < 2) return state;
  const i = leaf.tabs.findIndex((t) => t.id === leaf.activeTabId);
  const cur = i === -1 ? 0 : i;
  const delta = dir === "next" ? 1 : -1;
  const next = leaf.tabs[(cur + delta + leaf.tabs.length) % leaf.tabs.length];
  return setActiveTab(state, leaf.id, next.id);
}

/**
 * Move `tabId` from `source` pane to `target` pane at `target.index`.
 * When `source.paneId === target.paneId` this is an in-pane reorder.
 * When the source pane is emptied by the move it collapses (its space
 * returns to the parent split). The moved tab becomes active in its
 * destination and that pane gains focus. No-ops if the move is invalid
 * (missing tab/pane) or the destination is full.
 */
export function moveTab(
  state: WorkspaceState,
  source: { paneId: string; tabId: string },
  target: { paneId: string; index: number },
): WorkspaceState {
  const sourceLeaf = findLeaf(state.root, source.paneId);
  if (!sourceLeaf) return state;
  const moving = sourceLeaf.tabs.find((t) => t.id === source.tabId);
  if (!moving) return state;

  // In-pane reorder: splice without ever removing the leaf.
  if (source.paneId === target.paneId) {
    const root = rebuild(state.root, source.paneId, (leaf) => {
      const without = leaf.tabs.filter((t) => t.id !== source.tabId);
      const at = clampIndex(target.index, without.length);
      const tabs = [...without];
      tabs.splice(at, 0, moving);
      return { ...leaf, tabs, activeTabId: moving.id };
    });
    if (!root) return state;
    return { root, focusedPaneId: source.paneId };
  }

  const targetLeaf = findLeaf(state.root, target.paneId);
  if (!targetLeaf) return state;
  if (targetLeaf.tabs.length >= MAX_TABS_PER_PANE) return state;

  // Remove from source (may collapse), then insert into target.
  const removed = rebuild(state.root, source.paneId, (leaf) => {
    const tabs = leaf.tabs.filter((t) => t.id !== source.tabId);
    if (tabs.length === 0) return null;
    return withActiveTab(leaf, tabs);
  });
  if (!removed) return state;
  const inserted = rebuild(removed, target.paneId, (leaf) => {
    const at = clampIndex(target.index, leaf.tabs.length);
    const tabs = [...leaf.tabs];
    tabs.splice(at, 0, moving);
    return { ...leaf, tabs, activeTabId: moving.id };
  });
  if (!inserted) return state;
  const normalized = normalizeTree(inserted);
  return ensureFocus(normalized, target.paneId);
}

/**
 * Split pane `paneId` along `direction`, creating a sibling pane. The
 * new pane shows either the tab named by `opts.tabId` (moved out of
 * the source — "split with this tab") or, by default, a fresh tab
 * cloning the source's active-tab path so the user gets the same view
 * side-by-side (Obsidian's "Split right/down"). Focus moves to the new
 * pane. No-ops at the {@link MAX_LEAF_PANES} ceiling.
 */
export function splitPane(
  state: WorkspaceState,
  paneId: string,
  direction: SplitDirection,
  ids: SplitIds,
  opts: { tabId?: string } = {},
): WorkspaceState {
  const target = findLeaf(state.root, paneId);
  if (!target) return state;
  if (countLeaves(state.root) >= MAX_LEAF_PANES) return state;

  // The tab the new pane will show.
  let newTab: WorkspaceTab;
  let movingExisting = false;
  if (opts.tabId && target.tabs.some((t) => t.id === opts.tabId)) {
    // Don't strip the source pane's only tab — that would leave an
    // empty pane; clone instead.
    if (target.tabs.length > 1) {
      newTab = target.tabs.find((t) => t.id === opts.tabId)!;
      movingExisting = true;
    } else {
      newTab = { id: ids.newTabId, path: getActiveTab(target).path };
    }
  } else {
    newTab = { id: ids.newTabId, path: getActiveTab(target).path };
  }

  const root = rebuild(state.root, paneId, (leaf): WorkspaceNode => {
    const sourceTabs = movingExisting
      ? leaf.tabs.filter((t) => t.id !== newTab.id)
      : leaf.tabs;
    const sourceLeaf = movingExisting
      ? withActiveTab(leaf, sourceTabs)
      : leaf;
    const newLeaf: LeafPane = {
      type: "leaf",
      id: ids.newPaneId,
      tabs: [newTab],
      activeTabId: newTab.id,
    };
    return {
      type: "split",
      id: ids.newSplitId,
      direction,
      children: [sourceLeaf, newLeaf],
      sizes: [0.5, 0.5],
    };
  });
  if (!root) return state;
  const normalized = normalizeTree(root);
  return { root: normalized, focusedPaneId: ids.newPaneId };
}

/**
 * Replace the `sizes` of split `splitId`. Each fraction is clamped to
 * at least {@link MIN_PANE_FRACTION} and the result is renormalized to
 * sum to 1, so a splitter drag can never starve a pane to zero or push
 * the total off 1. No-ops if the split is missing or `sizes` has the
 * wrong length.
 */
export function resizeSplit(
  state: WorkspaceState,
  splitId: string,
  sizes: readonly number[],
): WorkspaceState {
  let found = false;
  const root = mapSplits(state.root, (split) => {
    if (split.id !== splitId) return split;
    if (sizes.length !== split.children.length) return split;
    found = true;
    return { ...split, sizes: clampSizesWithMin(sizes) };
  });
  if (!found) return state;
  return { ...state, root };
}

function mapSplits(
  node: WorkspaceNode,
  fn: (split: SplitPane) => SplitPane,
): WorkspaceNode {
  if (node.type === "leaf") return node;
  const children = node.children.map((c) => mapSplits(c, fn));
  const childrenChanged = children.some((c, i) => c !== node.children[i]);
  const base: SplitPane = childrenChanged ? { ...node, children } : node;
  return fn(base);
}

function clampIndex(index: number | undefined, length: number): number {
  if (index === undefined || !Number.isFinite(index)) return length;
  return Math.max(0, Math.min(Math.floor(index), length));
}

/**
 * Normalize a route path for storage. We persist UI route locations
 * only (never source content or secrets), so this just guarantees a
 * leading slash and trims trailing whitespace; anything that does not
 * look like an in-app path falls back to {@link DEFAULT_PATH}.
 */
export function normalizePath(path: string): string {
  if (typeof path !== "string") return DEFAULT_PATH;
  const trimmed = path.trim();
  if (trimmed === "") return DEFAULT_PATH;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * The persisted layout schema version. Bumped if the on-disk shape
 * changes incompatibly so {@link deserializeWorkspace} can reject (and
 * fall back to default) rather than mis-parse an old blob.
 */
export const WORKSPACE_SCHEMA_VERSION = 1;

interface PersistedWorkspace {
  readonly version: number;
  readonly state: WorkspaceState;
}

/**
 * Serialize a workspace to a compact JSON string for `localStorage`.
 * Only UI state is written — route path strings and opaque ids — never
 * source content, artifact bodies, or secrets, which matters for the
 * multi-tenant SME privacy posture.
 */
export function serializeWorkspace(state: WorkspaceState): string {
  const payload: PersistedWorkspace = {
    version: WORKSPACE_SCHEMA_VERSION,
    state,
  };
  return JSON.stringify(payload);
}

/**
 * Defensively parse a persisted workspace. Returns a validated,
 * invariant-repaired {@link WorkspaceState}, or `null` when the blob is
 * absent, not JSON, the wrong version, or structurally invalid — in
 * which case the caller falls back to {@link createDefaultWorkspace}.
 *
 * Validation is total and never throws: a corrupt layout must degrade
 * to the single-pane default, never crash the renderer on boot.
 */
export function deserializeWorkspace(
  raw: string | null | undefined,
): WorkspaceState | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.version !== WORKSPACE_SCHEMA_VERSION) return null;
  if (!isRecord(parsed.state)) return null;
  const focusedPaneId = parsed.state.focusedPaneId;
  if (typeof focusedPaneId !== "string") return null;

  const ids = new Set<string>();
  const root = parseNode(parsed.state.root, ids);
  if (!root) return null;
  const normalized = normalizeTree(root);
  // Re-point focus if the persisted id no longer maps to a leaf.
  return ensureFocus(normalized, focusedPaneId);
}

/**
 * Recursively validate and rebuild a node from untrusted JSON,
 * enforcing every invariant and de-duplicating ids. Returns `null` on
 * any structural violation so the whole layout is rejected (and the
 * default is used) rather than silently loading a half-valid tree.
 */
function parseNode(
  value: unknown,
  seenIds: Set<string>,
): WorkspaceNode | null {
  if (!isRecord(value)) return null;
  if (value.type === "leaf") {
    if (typeof value.id !== "string" || seenIds.has(value.id)) return null;
    seenIds.add(value.id);
    if (!Array.isArray(value.tabs) || value.tabs.length === 0) return null;
    const tabs: WorkspaceTab[] = [];
    for (const raw of value.tabs) {
      if (!isRecord(raw)) return null;
      if (typeof raw.id !== "string" || seenIds.has(raw.id)) return null;
      if (typeof raw.path !== "string") return null;
      seenIds.add(raw.id);
      tabs.push({ id: raw.id, path: normalizePath(raw.path) });
      if (tabs.length > MAX_TABS_PER_PANE) return null;
    }
    const activeTabId =
      typeof value.activeTabId === "string" &&
      tabs.some((t) => t.id === value.activeTabId)
        ? value.activeTabId
        : tabs[0].id;
    return { type: "leaf", id: value.id, tabs, activeTabId };
  }
  if (value.type === "split") {
    if (typeof value.id !== "string" || seenIds.has(value.id)) return null;
    seenIds.add(value.id);
    if (value.direction !== "row" && value.direction !== "column") return null;
    if (!Array.isArray(value.children) || value.children.length < 1) {
      return null;
    }
    const children: WorkspaceNode[] = [];
    for (const rawChild of value.children) {
      const child = parseNode(rawChild, seenIds);
      if (!child) return null;
      children.push(child);
    }
    const rawSizes = Array.isArray(value.sizes) ? value.sizes : [];
    const sizes =
      rawSizes.length === children.length &&
      rawSizes.every((s) => typeof s === "number")
        ? normalizeSizes(rawSizes as number[])
        : children.map(() => 1 / children.length);
    return { type: "split", id: value.id, direction: value.direction, children, sizes };
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Display helpers (pure, content-free)
// ---------------------------------------------------------------------------

/**
 * Human label for a tab, derived purely from its route path — never
 * from source/artifact content (which is neither loaded here nor
 * persisted). Keeps the tab strip readable while honoring the privacy
 * rule that the layout holds UI state only. Detail routes that embed
 * an opaque id (`/sources/:id`, `/artifacts/:id/edit`) get a generic
 * noun; the component can enrich the *live* (non-persisted) title from
 * loaded data if it chooses.
 */
export function tabTitleForPath(path: string): string {
  const clean = normalizePath(path);
  const end = Math.min(
    ...[clean.indexOf("#"), clean.indexOf("?")]
      .filter((i) => i !== -1)
      .concat(clean.length),
  );
  const pathname = clean.slice(0, end) || "/";
  const segments = pathname.split("/").filter(Boolean);

  if (segments.length === 0) return "Home";
  const [first, second] = segments;
  switch (first) {
    case "sources":
      return second ? "Source" : "Sources";
    case "templates":
      return "Templates";
    case "create":
      return "Create";
    case "tasks":
      return "Tasks";
    case "automations":
      return "Automations";
    case "vision":
      return "Vision";
    case "memory":
      return "Memory";
    case "settings":
      return "Settings";
    case "artifacts":
      return "Artifact";
    default:
      return capitalize(first);
  }
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}
