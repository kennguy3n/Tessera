import { useCallback, useEffect, useState } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
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
  // Review PR #87 ANALYSIS_0001.
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
          <Route path="/" element={<HomePage />} />
          <Route path="/sources" element={<SourcesPage />} />
          <Route path="/sources/:id" element={<SourceDetailPage />} />
          <Route path="/templates" element={<TemplatesPage />} />
          <Route path="/create" element={<CreatePage />} />
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/automations" element={<AutomationsPage />} />
          <Route path="/vision" element={<VisionPage />} />
          <Route path="/artifacts/:id/edit" element={<ArtifactEditorPage />} />
          <Route path="/settings" element={<SettingsPage />} />
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
