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

export default function App() {
  return (
    <div className="app-layout">
      <Sidebar />
      <main className="app-main">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/sources" element={<SourcesPage />} />
          <Route path="/sources/:id" element={<SourceDetailPage />} />
          <Route path="/templates" element={<TemplatesPage />} />
          <Route path="/create" element={<CreatePage />} />
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/automations" element={<AutomationsPage />} />
          <Route path="/artifacts/:id/edit" element={<ArtifactEditorPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
