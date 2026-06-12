import {
  useCallback,
  useEffect,
  useState,
  lazy,
  Suspense,
  type ReactNode,
} from "react";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import ErrorBoundary from "./components/ErrorBoundary";
import Sidebar from "./components/Sidebar";
import ModelDownloadBanner from "./components/ModelDownloadBanner";
import CommandPalette from "./components/CommandPalette";
import KeyboardShortcutsHelp from "./components/KeyboardShortcutsHelp";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useTheme } from "./hooks/useTheme";
import { useGlobalCommandActions } from "./hooks/useGlobalCommandActions";

// Lazy-mounted alongside the command palette: the quick switcher runs
// five IPC-backed list fetches the moment it mounts, so we defer that
// cost until the user first opens it (Cmd+O).
const QuickSwitcher = lazy(() => import("./components/QuickSwitcher"));

// LW-4: route-level code splitting. Each page (and the heavy editor
// module graph it pulls in — TipTap/ProseMirror, the sheet formula
// engine, Marp slide rendering) is loaded as its own lazy chunk on
// first navigation instead of being parsed into the initial bundle.
// This shrinks the renderer's startup parse/compile cost and keeps the
// V8 heap from holding code for pages a given session never visits.
const HomePage = lazy(() => import("./pages/HomePage"));
const SourcesPage = lazy(() => import("./pages/SourcesPage"));
const SourceDetailPage = lazy(() => import("./pages/SourceDetailPage"));
const TemplatesPage = lazy(() => import("./pages/TemplatesPage"));
const CreatePage = lazy(() => import("./pages/CreatePage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const ArtifactEditorPage = lazy(() => import("./pages/ArtifactEditorPage"));
const TasksPage = lazy(() => import("./pages/TasksPage"));
const AutomationsPage = lazy(() => import("./pages/AutomationsPage"));
const VisionPage = lazy(() => import("./pages/VisionPage"));
const MemoryPage = lazy(() => import("./pages/MemoryPage"));

type PaletteState = { open: boolean };

/**
 * Wrap a routed page element in a named {@link ErrorBoundary} so a
 * render-time crash in one page shows the recovery UI (and writes a
 * `crash-report.json` entry tagged with the page name) instead of
 * taking down the whole app shell. The sidebar and command palette
 * live outside the boundary and stay interactive.
 *
 * `resetKeys={[pathname]}` clears a caught error whenever the URL
 * changes. A static key alone is not enough: parameterized routes like
 * `/sources/:id` reuse the same boundary instance across ids, so a crash
 * on `/sources/a` would otherwise keep showing the recovery screen after
 * navigating to `/sources/b`. Keying on the full pathname covers both
 * cross-page and same-route-different-param navigation without
 * force-remounting healthy pages on unrelated re-renders.
 */
function PageBoundary({
  name,
  children,
}: {
  name: string;
  children: ReactNode;
}): ReactNode {
  const { pathname } = useLocation();
  return (
    <ErrorBoundary name={name} resetKeys={[pathname]}>
      {children}
    </ErrorBoundary>
  );
}

function page(name: string, node: ReactNode): ReactNode {
  return <PageBoundary name={name}>{node}</PageBoundary>;
}

/**
 * Suspense fallback shown while a lazily-loaded route chunk is being
 * fetched/parsed (LW-4 route-level code splitting). Chunks are local
 * files served by Electron, so this is typically a single frame on
 * first visit to a page; `aria-busy` keeps it announced for assistive
 * tech, matching the in-page "Loading..." pattern used by HomePage et
 * al. while their data hydrates.
 */
function RouteFallback(): ReactNode {
  return (
    <div
      aria-busy="true"
      style={{
        padding: "var(--spacing-lg)",
        color: "var(--color-text-secondary)",
      }}
    >
      Loading...
    </div>
  );
}

export default function App() {
  useKeyboardShortcuts();
  useTheme();
  useGlobalCommandActions();
  const [palette, setPalette] = useState<PaletteState>({ open: false });
  // The dedicated quick switcher (Cmd+O), lazy-mounted like the palette.
  const [quickSwitchOpen, setQuickSwitchOpen] = useState(false);
  const [quickSwitchHasMounted, setQuickSwitchHasMounted] = useState(false);
  // Lazy-mount the palette: the `CommandPalette` component runs
  // several IPC-backed hooks (`useArtifactList`, `usePinnedArtifacts`,
  // `useRecentlyViewedArtifacts`) whose fetches we don't want to pay
  // for users who never press Cmd+K (e.g. a session spent entirely on
  // one artifact). We flip this once the user opens the palette and
  // keep it mounted from then on so subsequent opens are instant
  // (the hooks stay warm and just observe state changes). Devin
  // Review PR #87.
  const [paletteHasMounted, setPaletteHasMounted] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const closePalette = useCallback(() => setPalette({ open: false }), []);
  const closeQuickSwitch = useCallback(() => setQuickSwitchOpen(false), []);

  useEffect(() => {
    // The palette, quick switcher, and shortcuts help are mutually
    // exclusive overlays: opening any one closes the other two so they
    // can never stack into a broken state.
    const openPalette = () => {
      setQuickSwitchOpen(false);
      setShortcutsOpen(false);
      setPalette({ open: true });
      setPaletteHasMounted(true);
    };
    const openQuickSwitch = () => {
      setPalette({ open: false });
      setShortcutsOpen(false);
      setQuickSwitchOpen(true);
      setQuickSwitchHasMounted(true);
    };
    const openShortcuts = () => {
      setPalette({ open: false });
      setQuickSwitchOpen(false);
      setShortcutsOpen(true);
    };
    const toggleSidebar = () => setSidebarCollapsed((v) => !v);
    window.addEventListener("tessera:open-palette", openPalette);
    window.addEventListener("tessera:open-quick-switch", openQuickSwitch);
    window.addEventListener("tessera:open-shortcuts", openShortcuts);
    window.addEventListener("tessera:toggle-sidebar", toggleSidebar);
    return () => {
      window.removeEventListener("tessera:open-palette", openPalette);
      window.removeEventListener("tessera:open-quick-switch", openQuickSwitch);
      window.removeEventListener("tessera:open-shortcuts", openShortcuts);
      window.removeEventListener("tessera:toggle-sidebar", toggleSidebar);
    };
  }, []);

  return (
    <div
      className={`app-layout ${
        sidebarCollapsed ? "app-layout-sidebar-collapsed" : ""
      }`}
    >
      <Sidebar collapsed={sidebarCollapsed} />
      <main className="app-main">
        <ModelDownloadBanner />
        <Suspense fallback={<RouteFallback />}>
          <Routes>
            <Route path="/" element={page("HomePage", <HomePage />)} />
            <Route
              path="/sources"
              element={page("SourcesPage", <SourcesPage />)}
            />
            <Route
              path="/sources/:id"
              element={page("SourceDetailPage", <SourceDetailPage />)}
            />
            <Route
              path="/templates"
              element={page("TemplatesPage", <TemplatesPage />)}
            />
            <Route
              path="/create"
              element={page("CreatePage", <CreatePage />)}
            />
            <Route path="/tasks" element={page("TasksPage", <TasksPage />)} />
            <Route
              path="/automations"
              element={page("AutomationsPage", <AutomationsPage />)}
            />
            <Route
              path="/vision"
              element={page("VisionPage", <VisionPage />)}
            />
            <Route
              path="/memory"
              element={page("MemoryPage", <MemoryPage />)}
            />
            <Route
              path="/artifacts/:id/edit"
              element={page("ArtifactEditorPage", <ArtifactEditorPage />)}
            />
            <Route
              path="/settings"
              element={page("SettingsPage", <SettingsPage />)}
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </main>
      {paletteHasMounted && (
        <CommandPalette isOpen={palette.open} onClose={closePalette} />
      )}
      {quickSwitchHasMounted && (
        <Suspense fallback={null}>
          <QuickSwitcher isOpen={quickSwitchOpen} onClose={closeQuickSwitch} />
        </Suspense>
      )}
      <KeyboardShortcutsHelp
        isOpen={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
      />
    </div>
  );
}
