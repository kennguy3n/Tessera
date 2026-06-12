import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  createPath,
  useLocation,
  useNavigate,
  type NavigateFunction,
} from "react-router-dom";
import {
  DEFAULT_PATH,
  closeTab as closeTabReducer,
  createDefaultWorkspace,
  deserializeWorkspace,
  focusAdjacentPane as focusAdjacentPaneReducer,
  focusAdjacentTab as focusAdjacentTabReducer,
  focusPane as focusPaneReducer,
  getActiveTab,
  getFocusedLeaf,
  moveTab as moveTabReducer,
  navigateTab as navigateTabReducer,
  openTab as openTabReducer,
  resizeSplit as resizeSplitReducer,
  serializeWorkspace,
  setActiveTab as setActiveTabReducer,
  splitPane as splitPaneReducer,
  type SplitDirection,
  type WorkspaceState,
} from "../utils/paneTree";
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from "./workspaceContext";

/**
 * `localStorage` key holding the persisted workspace layout. Only UI
 * state (route paths + opaque ids + split sizes) is stored — never
 * source content, artifact bodies, or secrets — so a shared / synced
 * profile can't leak tenant data through the layout blob.
 */
const STORAGE_KEY = "tessera:workspace-layout";

/** Debounce window for persisting layout changes (ms). Coalesces
 *  bursts (e.g. dragging a splitter) into a single write. */
const PERSIST_DEBOUNCE_MS = 200;

function genId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback for environments without WebCrypto (very old WebViews).
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function loadInitialWorkspace(): WorkspaceState {
  try {
    if (typeof localStorage !== "undefined") {
      const restored = deserializeWorkspace(localStorage.getItem(STORAGE_KEY));
      if (restored) return restored;
    }
  } catch {
    // A locked-down / throwing storage falls back to the default.
  }
  return createDefaultWorkspace({ paneId: genId(), tabId: genId() });
}

interface WorkspaceProviderProps {
  children: ReactNode;
}

/**
 * Owns the workspace layout state and bridges it to react-router.
 *
 * Two routing planes coexist:
 *
 *   1. **Shell plane** — the app's single top-level router (the
 *      `BrowserRouter` from `main.tsx`, or a test's `MemoryRouter`).
 *      The sidebar, command palette, quick switcher, and keyboard
 *      runner all call `useNavigate()` / render `<NavLink>` against it,
 *      exactly as before this feature. We do **not** introduce a second
 *      `<Router>` (react-router forbids nesting one router inside
 *      another); instead a small effect-based **bridge** keeps the
 *      shell location and the focused tab in sync in both directions:
 *      a genuine shell navigation (sidebar / palette / keyboard) is
 *      forwarded into the focused tab, and any change to the focused
 *      tab's path (tab switch, pane focus, in-tab `<Link>`) is mirrored
 *      back onto the shell URL so `<NavLink>` highlighting stays correct.
 *
 *   2. **Per-tab plane** — each visible pane's active tab mounts its own
 *      in-memory router (see `TabView`). It registers its `navigate`
 *      here so the bridge can reach it, and reports location changes
 *      back so the layout + persisted blob stay in sync. This gives
 *      every tab independent history (back/forward) without coupling to
 *      the global URL — the key requirement for Obsidian-style splits
 *      where several routed views are visible at once.
 *
 * The reducers in `utils/paneTree` do all the real work; this provider
 * just generates ids, persists (debounced) UI-only state, and wires the
 * `tessera:*` window-event bus to the API so keyboard/command triggers
 * and direct UI gestures share one code path.
 */
export default function WorkspaceProvider({
  children,
}: WorkspaceProviderProps): ReactNode {
  const [state, setState] = useState<WorkspaceState>(loadInitialWorkspace);

  // The app's single top-level router (BrowserRouter / MemoryRouter).
  const outerNavigate = useNavigate();
  const outerLocation = useLocation();

  // "Latest value" refs so the imperative API + the navigate-delta
  // listener can read current values without re-subscribing.
  const stateRef = useRef(state);
  stateRef.current = state;

  // tabId -> the tab's own `navigate` (from its in-memory router).
  const navigatorsRef = useRef<Map<string, NavigateFunction>>(new Map());

  const focusedLeaf = getFocusedLeaf(state);
  const activePath = getActiveTab(focusedLeaf).path;
  const activePathRef = useRef(activePath);
  activePathRef.current = activePath;

  // --- Persistence (debounced, best-effort, UI-state only) ---
  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    const handle = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, serializeWorkspace(state));
      } catch {
        // Persisting layout is best-effort; the in-memory state still
        // drives this session even if storage is unavailable/full.
      }
    }, PERSIST_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [state]);

  // --- Per-tab router bridge ---
  const registerTabNavigator = useCallback(
    (tabId: string, navigate: NavigateFunction) => {
      navigatorsRef.current.set(tabId, navigate);
    },
    [],
  );
  const unregisterTabNavigator = useCallback((tabId: string) => {
    navigatorsRef.current.delete(tabId);
  }, []);
  const reportTabLocation = useCallback(
    (paneId: string, tabId: string, path: string) => {
      setState((cur) => navigateTabReducer(cur, paneId, tabId, path));
    },
    [],
  );

  // --- Imperative navigation of the focused tab ---
  const navigateActive = useCallback(
    (path: string, opts?: { replace?: boolean }) => {
      const cur = stateRef.current;
      const leaf = getFocusedLeaf(cur);
      const tab = getActiveTab(leaf);
      const navigate = navigatorsRef.current.get(tab.id);
      if (navigate) {
        navigate(path, { replace: opts?.replace ?? false });
      } else {
        // Tab not yet mounted (first paint race): record the path so its
        // router mounts there; the bridge reconciles once it registers.
        setState((s) => navigateTabReducer(s, leaf.id, tab.id, path));
      }
    },
    [],
  );

  // --- Layout mutations (thin wrappers over the pure reducers) ---
  const openTab = useCallback((path?: string, paneId?: string) => {
    setState((cur) => {
      const target = paneId ?? getFocusedLeaf(cur).id;
      return openTabReducer(cur, target, {
        id: genId(),
        path: path ?? DEFAULT_PATH,
      });
    });
  }, []);

  const closeTab = useCallback((paneId: string, tabId: string) => {
    setState((cur) => closeTabReducer(cur, paneId, tabId));
  }, []);

  const closeActiveTab = useCallback(() => {
    setState((cur) => {
      const leaf = getFocusedLeaf(cur);
      return closeTabReducer(cur, leaf.id, getActiveTab(leaf).id);
    });
  }, []);

  const activateTab = useCallback((paneId: string, tabId: string) => {
    setState((cur) => setActiveTabReducer(cur, paneId, tabId));
  }, []);

  const splitFocused = useCallback(
    (direction: SplitDirection, tabId?: string) => {
      setState((cur) =>
        splitPaneReducer(
          cur,
          getFocusedLeaf(cur).id,
          direction,
          { newPaneId: genId(), newTabId: genId(), newSplitId: genId() },
          { tabId },
        ),
      );
    },
    [],
  );

  const focusPane = useCallback((paneId: string) => {
    setState((cur) => focusPaneReducer(cur, paneId));
  }, []);

  const focusAdjacentPane = useCallback((dir: "next" | "prev") => {
    setState((cur) => focusAdjacentPaneReducer(cur, dir));
  }, []);

  const focusAdjacentTab = useCallback((dir: "next" | "prev") => {
    setState((cur) => focusAdjacentTabReducer(cur, dir));
  }, []);

  const moveTab = useCallback(
    (
      source: { paneId: string; tabId: string },
      target: { paneId: string; index: number },
    ) => {
      setState((cur) => moveTabReducer(cur, source, target));
    },
    [],
  );

  const resizeSplit = useCallback((splitId: string, sizes: number[]) => {
    setState((cur) => resizeSplitReducer(cur, splitId, sizes));
  }, []);

  // --- tessera:* command bus → workspace API ---
  useEffect(() => {
    const onNewTab = () => openTab();
    const onCloseTab = () => closeActiveTab();
    const onNextTab = () => focusAdjacentTab("next");
    const onPrevTab = () => focusAdjacentTab("prev");
    const onSplitRight = () => splitFocused("row");
    const onSplitDown = () => splitFocused("column");
    const onFocusNextPane = () => focusAdjacentPane("next");
    const onFocusPrevPane = () => focusAdjacentPane("prev");
    window.addEventListener("tessera:new-tab", onNewTab);
    window.addEventListener("tessera:close-tab", onCloseTab);
    window.addEventListener("tessera:next-tab", onNextTab);
    window.addEventListener("tessera:prev-tab", onPrevTab);
    window.addEventListener("tessera:split-right", onSplitRight);
    window.addEventListener("tessera:split-down", onSplitDown);
    window.addEventListener("tessera:focus-next-pane", onFocusNextPane);
    window.addEventListener("tessera:focus-prev-pane", onFocusPrevPane);
    return () => {
      window.removeEventListener("tessera:new-tab", onNewTab);
      window.removeEventListener("tessera:close-tab", onCloseTab);
      window.removeEventListener("tessera:next-tab", onNextTab);
      window.removeEventListener("tessera:prev-tab", onPrevTab);
      window.removeEventListener("tessera:split-right", onSplitRight);
      window.removeEventListener("tessera:split-down", onSplitDown);
      window.removeEventListener("tessera:focus-next-pane", onFocusNextPane);
      window.removeEventListener("tessera:focus-prev-pane", onFocusPrevPane);
    };
  }, [
    openTab,
    closeActiveTab,
    focusAdjacentTab,
    splitFocused,
    focusAdjacentPane,
  ]);

  // --- Shell <-> focused-tab location bridge ---
  // Tracks the previous shell/tab paths so each render we can tell which
  // side changed and sync the other, without a feedback loop. Seeded to
  // `null` so the first run always establishes the shell URL from the
  // (possibly restored) focused-tab path rather than treating the
  // initial "/" shell location as a user navigation.
  const prevActiveRef = useRef<string | null>(null);
  const prevOuterRef = useRef<string | null>(null);
  useEffect(() => {
    const outerPath = createPath(outerLocation);
    const activeChanged = activePath !== prevActiveRef.current;
    const outerChanged = outerPath !== prevOuterRef.current;
    prevActiveRef.current = activePath;
    prevOuterRef.current = outerPath;

    if (activeChanged && activePath !== outerPath) {
      // The focused tab moved (tab switch, pane focus, in-tab <Link>):
      // mirror it onto the shell URL (replace — the shell URL is a
      // reflection, not a per-tab history) so <NavLink> highlights track
      // the focused view.
      prevOuterRef.current = activePath;
      outerNavigate(activePath, { replace: true });
      return;
    }
    if (outerChanged && outerPath !== activePath) {
      // A genuine shell navigation (sidebar / palette / keyboard):
      // forward it into the focused tab's own router.
      navigateActive(outerPath);
    }
  }, [activePath, outerLocation, outerNavigate, navigateActive]);

  // Relative history navigation (Cmd+[ "Go back") targets the focused
  // tab's in-memory router, not the shell — each tab owns its own
  // back/forward stack. Fired by the keyboard runner / command palette.
  useEffect(() => {
    const onDelta = (e: Event) => {
      const delta = (e as CustomEvent<{ delta?: number }>).detail?.delta;
      if (typeof delta !== "number" || delta === 0) return;
      const tab = getActiveTab(getFocusedLeaf(stateRef.current));
      navigatorsRef.current.get(tab.id)?.(delta);
    };
    window.addEventListener("tessera:navigate-delta", onDelta);
    return () => window.removeEventListener("tessera:navigate-delta", onDelta);
  }, []);

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      state,
      activePath,
      openTab,
      closeTab,
      closeActiveTab,
      activateTab,
      navigateActive,
      splitFocused,
      focusPane,
      focusAdjacentPane,
      focusAdjacentTab,
      moveTab,
      resizeSplit,
      registerTabNavigator,
      unregisterTabNavigator,
      reportTabLocation,
    }),
    [
      state,
      activePath,
      openTab,
      closeTab,
      closeActiveTab,
      activateTab,
      navigateActive,
      splitFocused,
      focusPane,
      focusAdjacentPane,
      focusAdjacentTab,
      moveTab,
      resizeSplit,
      registerTabNavigator,
      unregisterTabNavigator,
      reportTabLocation,
    ],
  );

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
}
