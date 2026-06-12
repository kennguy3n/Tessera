import { memo, useEffect, type ReactNode } from "react";
import {
  MemoryRouter,
  useLocation,
  useNavigate,
  UNSAFE_LocationContext,
  UNSAFE_NavigationContext,
  UNSAFE_RouteContext,
} from "react-router-dom";
import AppRoutes from "../components/AppRoutes";
import { useWorkspace } from "./workspaceContext";

/**
 * Reset the ambient react-router contexts to their top-level defaults so
 * the per-tab {@link MemoryRouter} below can mount as if it were the
 * root router.
 *
 * react-router v6 forbids rendering a `<Router>` inside another (it
 * `invariant`s on `useInRouterContext()`, which reads `LocationContext`).
 * The app already has one top-level router (the shell `BrowserRouter` /
 * a test `MemoryRouter`), and each tab needs its *own* independent
 * history so several routed views can be visible at once — the defining
 * requirement of Obsidian-style splits. Nulling the inherited contexts
 * is react-router's sanctioned escape hatch for embedding an isolated
 * router (the `UNSAFE_` prefix denotes "internal API", not "unsafe to
 * use"); the inner `MemoryRouter` immediately re-establishes fresh
 * Navigation/Location contexts for its subtree, so every routing hook
 * inside a tab (`useNavigate`, `useLocation`, `useParams`) resolves to
 * that tab's router. Clearing `RouteContext` keeps the tab's `<Routes>`
 * matching from the root rather than as a nested descendant.
 */
function RouterIsolation({ children }: { children: ReactNode }): ReactNode {
  return (
    <UNSAFE_NavigationContext.Provider value={null as never}>
      <UNSAFE_LocationContext.Provider value={null as never}>
        <UNSAFE_RouteContext.Provider
          value={{ outlet: null, matches: [], isDataRoute: false }}
        >
          {children}
        </UNSAFE_RouteContext.Provider>
      </UNSAFE_LocationContext.Provider>
    </UNSAFE_NavigationContext.Provider>
  );
}

interface TabViewProps {
  paneId: string;
  tabId: string;
  /** The tab's stored path at mount time; seeds this tab's history. */
  initialPath: string;
}

/**
 * Bridges a tab's in-memory router to the workspace store:
 *   - registers the tab's `navigate` so the shell navigator can drive
 *     the focused tab imperatively (sidebar / palette / keyboard), and
 *   - reports every location change back so the layout — and the
 *     persisted blob — track in-tab navigation.
 *
 * Renders nothing.
 */
function TabRouterController({
  paneId,
  tabId,
}: {
  paneId: string;
  tabId: string;
}): ReactNode {
  const { registerTabNavigator, unregisterTabNavigator, reportTabLocation } =
    useWorkspace();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    registerTabNavigator(tabId, navigate);
    return () => unregisterTabNavigator(tabId);
  }, [tabId, navigate, registerTabNavigator, unregisterTabNavigator]);

  const full = `${location.pathname}${location.search}${location.hash}`;
  useEffect(() => {
    reportTabLocation(paneId, tabId, full);
  }, [paneId, tabId, full, reportTabLocation]);

  return null;
}

/**
 * One tab's content: the full application route table mounted against
 * its own in-memory history, so this tab navigates independently of
 * every other tab and of the global URL. Only the active tab of each
 * visible pane is mounted (inactive tabs are unmounted by `Pane`),
 * which keeps render cost and IPC bounded — a backgrounded tab runs no
 * page hooks until it is activated again.
 *
 * Keyed by `tabId` at the call site so switching the active tab mounts
 * a fresh router seeded from the stored path, rather than re-pointing
 * an existing one.
 */
function TabView({ paneId, tabId, initialPath }: TabViewProps): ReactNode {
  return (
    <RouterIsolation>
      <MemoryRouter initialEntries={[initialPath]}>
        <TabRouterController paneId={paneId} tabId={tabId} />
        <AppRoutes />
      </MemoryRouter>
    </RouterIsolation>
  );
}

export default memo(TabView);
