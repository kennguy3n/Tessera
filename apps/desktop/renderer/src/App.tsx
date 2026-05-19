import { Routes, Route, Navigate } from "react-router-dom";
import Sidebar from "./components/Sidebar";
import HomePage from "./pages/HomePage";
import SourcesPage from "./pages/SourcesPage";
import TemplatesPage from "./pages/TemplatesPage";
import CreatePage from "./pages/CreatePage";
import SettingsPage from "./pages/SettingsPage";

export default function App() {
  return (
    <div className="app-layout">
      <Sidebar />
      <main className="app-main">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/sources" element={<SourcesPage />} />
          <Route path="/templates" element={<TemplatesPage />} />
          <Route path="/create" element={<CreatePage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
