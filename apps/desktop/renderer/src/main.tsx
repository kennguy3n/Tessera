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

// Showcase mock bridge: `?showcase=<persona>` injects genuine
// LLM-generated artifacts into the live renderer for capturing demo
// screenshots and driving the deterministic QA gates (visual-regression
// + the browser a11y contrast pass). `?theme=` / `?accent=` seed the
// theme so captures are reproducible.
//
// It is enabled in two cases only:
//   - `import.meta.env.DEV`           — the local `vite` dev server.
//   - `import.meta.env.VITE_TESSERA_QA` — the dedicated `build:qa`
//     production bundle the QA harness serves (see vite.config.ts).
//
// In the REAL `npm run build`, both flags are statically false, so this
// whole branch (and the dynamic `import("./showcase")`) is tree-shaken
// out and the showcase datasets never enter the shipped renderer.
const SHOWCASE_ENABLED =
  import.meta.env.DEV || import.meta.env.VITE_TESSERA_QA === "true";
if (
  SHOWCASE_ENABLED &&
  new URLSearchParams(window.location.search).has("showcase")
) {
  void import("./showcase")
    .then(
      ({
        installShowcaseBridge,
        showcasePersonaFromQuery,
        showcaseThemeFromQuery,
      }) => {
        const resolved = showcasePersonaFromQuery();
        if (resolved) installShowcaseBridge(resolved, showcaseThemeFromQuery());
      },
    )
    .catch((err) => {
      // The showcase harness is a dev/QA-only convenience; if it fails to
      // load we still render the real app rather than leaving a blank page.
      console.error("Failed to load showcase bridge:", err);
    })
    .finally(renderApp);
} else {
  renderApp();
}
