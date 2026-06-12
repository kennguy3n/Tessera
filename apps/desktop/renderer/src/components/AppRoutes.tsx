import { lazy, Suspense, type ReactNode } from "react";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import ErrorBoundary from "./ErrorBoundary";

// LW-4: route-level code splitting. Each page (and the heavy editor
// module graph it pulls in — TipTap/ProseMirror, the sheet formula
// engine, Marp slide rendering) is loaded as its own lazy chunk on
// first navigation instead of being parsed into the initial bundle.
// This shrinks the renderer's startup parse/compile cost and keeps the
// V8 heap from holding code for pages a given session never visits.
// Each workspace tab renders this same routed tree against its own
// in-memory location, so the lazy chunks are shared across every tab.
const HomePage = lazy(() => import("../pages/HomePage"));
const SourcesPage = lazy(() => import("../pages/SourcesPage"));
const SourceDetailPage = lazy(() => import("../pages/SourceDetailPage"));
const TemplatesPage = lazy(() => import("../pages/TemplatesPage"));
const CreatePage = lazy(() => import("../pages/CreatePage"));
const SettingsPage = lazy(() => import("../pages/SettingsPage"));
const ArtifactEditorPage = lazy(() => import("../pages/ArtifactEditorPage"));
const TasksPage = lazy(() => import("../pages/TasksPage"));
const AutomationsPage = lazy(() => import("../pages/AutomationsPage"));
const VisionPage = lazy(() => import("../pages/VisionPage"));
const MemoryPage = lazy(() => import("../pages/MemoryPage"));

/**
 * Wrap a routed page element in a named {@link ErrorBoundary} so a
 * render-time crash in one page shows the recovery UI (and writes a
 * `crash-report.json` entry tagged with the page name) instead of
 * taking down the whole app shell. The sidebar and command palette
 * live outside the boundary and stay interactive. In the split-pane
 * workspace each tab gets its own boundary, so a crash in one tab
 * cannot take down a neighboring pane.
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

/**
 * The application's route table. Mounted once per workspace tab inside
 * that tab's own router (an in-memory history), so every tab navigates
 * independently of the others and of the global URL. Extracted from
 * `App` so the single source of truth for the route↔page mapping is
 * reused by every pane.
 */
export default function AppRoutes(): ReactNode {
  return (
    <Suspense fallback={<RouteFallback />}>
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
        <Route path="/memory" element={page("MemoryPage", <MemoryPage />)} />
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
  );
}
