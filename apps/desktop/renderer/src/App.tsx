import { useCallback, useEffect, useState, lazy, Suspense } from "react";
import Sidebar from "./components/Sidebar";
import ModelDownloadBanner from "./components/ModelDownloadBanner";
import CommandPalette from "./components/CommandPalette";
import KeyboardShortcutsHelp from "./components/KeyboardShortcutsHelp";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useTheme } from "./hooks/useTheme";
import { useGlobalCommandActions } from "./hooks/useGlobalCommandActions";
import WorkspaceProvider from "./workspace/WorkspaceProvider";
import WorkspaceView from "./workspace/WorkspaceView";

// Lazy-mounted alongside the command palette: the quick switcher runs
// five IPC-backed list fetches the moment it mounts, so we defer that
// cost until the user first opens it (Cmd+O).
const QuickSwitcher = lazy(() => import("./components/QuickSwitcher"));

type PaletteState = { open: boolean };

/**
 * The application shell: persistent sidebar, the split-pane workspace,
 * and the global overlays (command palette, quick switcher, keyboard
 * help). Rendered beneath {@link WorkspaceProvider}, whose effect-based
 * bridge forwards the sidebar's `<NavLink>` / keyboard / command-palette
 * navigation (all driving the app's single top-level router) into the
 * focused pane's active tab — so those components need no per-component
 * change.
 */
function AppShell() {
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
      <main className="app-main app-main-workspace">
        <ModelDownloadBanner />
        <WorkspaceView />
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

/**
 * Root component. Owns the workspace layout state (and its persistence)
 * via {@link WorkspaceProvider} and renders the shell beneath it. The
 * top-level `BrowserRouter` from `main.tsx` remains the app's only
 * router; the provider bridges its navigation into the focused tab.
 */
export default function App() {
  return (
    <WorkspaceProvider>
      <AppShell />
    </WorkspaceProvider>
  );
}
