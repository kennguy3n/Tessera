import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import { ToastProvider } from "./components/Toast";
import "./styles/tokens.css";
import "./styles/global.css";
import "./styles/components.css";

function renderApp() {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <ErrorBoundary>
        <ToastProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </ToastProvider>
      </ErrorBoundary>
    </React.StrictMode>,
  );
}

// DEV-only showcase mock bridge: `?showcase=<persona>` injects genuine
// LLM-generated artifacts into the live renderer for capturing demo
// screenshots. Stripped from production builds by the `import.meta.env.DEV`
// guard + dynamic import (so the showcase datasets never enter the prod bundle).
if (import.meta.env.DEV && new URLSearchParams(window.location.search).has("showcase")) {
  void import("./showcase").then(({ installShowcaseBridge, showcasePersonaFromQuery }) => {
    const resolved = showcasePersonaFromQuery();
    if (resolved) installShowcaseBridge(resolved);
    renderApp();
  });
} else {
  renderApp();
}
