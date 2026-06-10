import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import BridgeGate from "./components/BridgeGate";
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
            <BridgeGate>
              <App />
            </BridgeGate>
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
  void import("./showcase")
    .then(({ installShowcaseBridge, showcasePersonaFromQuery }) => {
      const resolved = showcasePersonaFromQuery();
      if (resolved) installShowcaseBridge(resolved);
    })
    .catch((err) => {
      // The showcase harness is a dev-only convenience; if it fails to load
      // we still render the real app rather than leaving a blank page.
      console.error("Failed to load showcase bridge:", err);
    })
    .finally(renderApp);
} else {
  renderApp();
}
