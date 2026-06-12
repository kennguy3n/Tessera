import { createContext, useContext } from "react";
import type { NavigateFunction, Navigator as RRNavigator } from "react-router-dom";
import type {
  SplitDirection,
  WorkspaceState,
} from "../utils/paneTree";

/**
 * Imperative + reactive API exposed by {@link WorkspaceProvider}.
 *
 * The reactive `state` drives rendering of the pane tree; the methods
 * are thin wrappers around the pure reducers in `utils/paneTree` (they
 * generate ids and thread `setState`). UI components (tab strips,
 * splitters, the pane chrome) read this via {@link useWorkspace};
 * keyboard / command-palette triggers reach it through the
 * `tessera:*` window-event bus that the provider also listens to, so
 * there is exactly one code path per mutation.
 */
export interface WorkspaceContextValue {
  /** The current layout tree + focused pane. */
  readonly state: WorkspaceState;
  /** Route path of the focused pane's active tab (drives sidebar
   *  active state and the shell router's location). */
  readonly activePath: string;

  /** Open a new tab (default: Home) in `paneId` or the focused pane. */
  openTab(path?: string, paneId?: string): void;
  /** Close a specific tab. */
  closeTab(paneId: string, tabId: string): void;
  /** Close the focused pane's active tab. */
  closeActiveTab(): void;
  /** Activate (and focus) a tab. */
  activateTab(paneId: string, tabId: string): void;
  /** Navigate the focused pane's active tab to `path`. */
  navigateActive(path: string, opts?: { replace?: boolean }): void;
  /** Split the focused pane; optionally move `tabId` into the new pane. */
  splitFocused(direction: SplitDirection, tabId?: string): void;
  /** Move focus to a specific pane. */
  focusPane(paneId: string): void;
  /** Cycle focus across panes. */
  focusAdjacentPane(dir: "next" | "prev"): void;
  /** Cycle the active tab within the focused pane. */
  focusAdjacentTab(dir: "next" | "prev"): void;
  /** Move/reorder a tab between (or within) panes. */
  moveTab(
    source: { paneId: string; tabId: string },
    target: { paneId: string; index: number },
  ): void;
  /** Apply new child sizes to a split (fractions summing to 1). */
  resizeSplit(splitId: string, sizes: number[]): void;

  // --- Per-tab router bridge (used by TabView, not app code) ---
  /** Register a mounted tab's `navigate` so external navigation (sidebar,
   *  palette, keyboard) can drive the focused tab imperatively. */
  registerTabNavigator(tabId: string, navigate: NavigateFunction): void;
  /** Deregister on unmount. */
  unregisterTabNavigator(tabId: string): void;
  /** A tab reports its current location back so the layout (and the
   *  persisted blob) stay in sync with in-tab navigation. */
  reportTabLocation(paneId: string, tabId: string, path: string): void;
}

export const WorkspaceContext = createContext<WorkspaceContextValue | null>(
  null,
);

/**
 * Access the workspace API. Throws if used outside a
 * {@link WorkspaceProvider} so a wiring mistake fails loudly in dev
 * instead of silently no-oping.
 */
export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) {
    throw new Error("useWorkspace must be used within a WorkspaceProvider");
  }
  return ctx;
}

export type { RRNavigator };
