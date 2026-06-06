import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import ErrorBoundary from "./components/ErrorBoundary";
import Sidebar from "./components/Sidebar";
import HomePage from "./pages/HomePage";
import SourcesPage from "./pages/SourcesPage";
import SourceDetailPage from "./pages/SourceDetailPage";
import TemplatesPage from "./pages/TemplatesPage";
import CreatePage from "./pages/CreatePage";
import SettingsPage from "./pages/SettingsPage";
import ArtifactEditorPage from "./pages/ArtifactEditorPage";
import TasksPage from "./pages/TasksPage";
import AutomationsPage from "./pages/AutomationsPage";
import VisionPage from "./pages/VisionPage";
import CommandPalette from "./components/CommandPalette";
import KeyboardShortcutsHelp from "./components/KeyboardShortcutsHelp";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useTheme } from "./hooks/useTheme";

type PaletteState = { open: boolean; mode: "full" | "quickSwitcher" };

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

export default function App() {
  useKeyboardShortcuts();
  useTheme();
  const [palette, setPalette] = useState<PaletteState>({
    open: false,
    mode: "full",
  });
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

  const closePalette = useCallback(
    () => setPalette({ open: false, mode: "full" }),
    [],
  );

  useEffect(() => {
    const openPalette = (e: Event) => {
      const detail =
        e instanceof CustomEvent && e.detail && typeof e.detail === "object"
          ? (e.detail as { mode?: "full" | "quickSwitcher" })
          : undefined;
      setPalette({ open: true, mode: detail?.mode ?? "full" });
      setPaletteHasMounted(true);
    };
    const openShortcuts = () => setShortcutsOpen(true);
    const toggleSidebar = () => setSidebarCollapsed((v) => !v);
    window.addEventListener("tessera:open-palette", openPalette);
    window.addEventListener("tessera:open-shortcuts", openShortcuts);
    window.addEventListener("tessera:toggle-sidebar", toggleSidebar);
    return () => {
      window.removeEventListener("tessera:open-palette", openPalette);
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
        <Routes>
          <Route path="/" element={page("HomePage", <HomePage />)} />
          <Route path="/sources" element={page("SourcesPage", <SourcesPage />)} />
          <Route
            path="/sources/:id"
            element={page("SourceDetailPage", <SourceDetailPage />)}
          />
          <Route
            path="/templates"
            element={page("TemplatesPage", <TemplatesPage />)}
          />
          <Route path="/create" element={page("CreatePage", <CreatePage />)} />
          <Route path="/tasks" element={page("TasksPage", <TasksPage />)} />
          <Route
            path="/automations"
            element={page("AutomationsPage", <AutomationsPage />)}
          />
          <Route path="/vision" element={page("VisionPage", <VisionPage />)} />
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
      </main>
      {paletteHasMounted && (
        <CommandPalette
          isOpen={palette.open}
          mode={palette.mode}
          onClose={closePalette}
        />
      )}
      <KeyboardShortcutsHelp
        isOpen={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
      />
    </div>
  );
}
