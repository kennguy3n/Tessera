/**
 * Automated accessibility audit — every top-level route/page.
 *
 * Each page is mounted inside a faithful copy of the real application
 * shell's landmark structure (a `<main>` content region, matching
 * `App.tsx`'s `<main className="app-main">`) so axe's region/landmark
 * reasoning matches production, then audited with the shared WCAG 2.1
 * AA rule set (see `axeHelper.ts`). Pages issue bridge IPC on mount via
 * the global `window.tessera` mock from `setup.ts`; we wait for each
 * page's loading state to settle before auditing so we measure the real
 * populated/empty UI rather than a transient skeleton.
 *
 * Color-contrast is intentionally NOT decided here (jsdom does not
 * paint) — it is covered in both themes by the browser pass in
 * `qa/a11y.spec.ts`. This suite owns the structural contract.
 */
import { describe, it, beforeEach, vi } from "vitest";
import {
  render,
  screen,
  waitFor,
  type RenderResult,
} from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import type { ReactElement, ReactNode } from "react";

import { ToastProvider } from "../../components/Toast";
import WorkspaceProvider from "../../workspace/WorkspaceProvider";
import { expectNoA11yViolations } from "./axeHelper";

import HomePage from "../../pages/HomePage";
import SourcesPage from "../../pages/SourcesPage";
import SourceDetailPage from "../../pages/SourceDetailPage";
import TemplatesPage from "../../pages/TemplatesPage";
import CreatePage from "../../pages/CreatePage";
import TasksPage from "../../pages/TasksPage";
import AutomationsPage from "../../pages/AutomationsPage";
import VisionPage from "../../pages/VisionPage";
import MemoryPage from "../../pages/MemoryPage";
import SettingsPage from "../../pages/SettingsPage";

/**
 * Mount a page inside the real shell landmarks + the providers it can
 * legitimately assume are present (the toast portal and the workspace
 * layout context, both mounted above every page in `main.tsx` /
 * `App.tsx`). The page element is placed in `<main>` exactly as the app
 * does, so "content must live in a landmark" is satisfied structurally
 * rather than by suppressing the rule.
 */
function renderPage(
  ui: ReactElement,
  { route = "/", path }: { route?: string; path?: string } = {},
): RenderResult {
  const routed: ReactNode = path ? (
    <Routes>
      <Route path={path} element={ui} />
    </Routes>
  ) : (
    ui
  );
  return render(
    <MemoryRouter initialEntries={[route]}>
      <ToastProvider>
        <WorkspaceProvider>
          <main className="app-main">{routed}</main>
        </WorkspaceProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

/**
 * Wait for a page's initial async data load to settle. Pages render a
 * "Loading…" affordance while their mount-time IPC resolves; auditing
 * before it clears would measure the skeleton, not the page. We poll
 * until no loading indicator remains (or there never was one).
 */
async function waitForSettled(): Promise<void> {
  await waitFor(() => {
    const loading = screen.queryAllByText(/^loading/i);
    if (loading.length > 0) {
      throw new Error("still loading");
    }
  });
}

describe("Accessibility — top-level pages", () => {
  beforeEach(() => {
    // jsdom has no layout, so anything that measures the viewport must
    // be stubbed deterministically. matchMedia is consulted by a few
    // pages for responsive affordances.
    if (!window.matchMedia) {
      window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }));
    }
  });

  it("Home (/) has no structural a11y violations", async () => {
    const { container } = renderPage(<HomePage />);
    await waitForSettled();
    await expectNoA11yViolations(container);
  });

  it("Sources (/sources) has no structural a11y violations", async () => {
    const { container } = renderPage(<SourcesPage />, { route: "/sources" });
    await waitForSettled();
    await expectNoA11yViolations(container);
  });

  it("Source detail (/sources/:id) has no structural a11y violations", async () => {
    const { container } = renderPage(<SourceDetailPage />, {
      route: "/sources/src-1",
      path: "/sources/:id",
    });
    await waitForSettled();
    await expectNoA11yViolations(container);
  });

  it("Templates (/templates) has no structural a11y violations", async () => {
    const { container } = renderPage(<TemplatesPage />, {
      route: "/templates",
    });
    await waitForSettled();
    await expectNoA11yViolations(container);
  });

  it("Create (/create) has no structural a11y violations", async () => {
    const { container } = renderPage(<CreatePage />, { route: "/create" });
    await waitForSettled();
    await expectNoA11yViolations(container);
  });

  it("Tasks (/tasks) has no structural a11y violations", async () => {
    const { container } = renderPage(<TasksPage />, { route: "/tasks" });
    await waitForSettled();
    await expectNoA11yViolations(container);
  });

  it("Automations (/automations) has no structural a11y violations", async () => {
    const { container } = renderPage(<AutomationsPage />, {
      route: "/automations",
    });
    await waitForSettled();
    await expectNoA11yViolations(container);
  });

  it("Vision (/vision) has no structural a11y violations", async () => {
    const { container } = renderPage(<VisionPage />, { route: "/vision" });
    await waitForSettled();
    await expectNoA11yViolations(container);
  });

  it("Memory (/memory) has no structural a11y violations", async () => {
    const { container } = renderPage(<MemoryPage />, { route: "/memory" });
    await waitForSettled();
    await expectNoA11yViolations(container);
  });

  it("Settings (/settings) has no structural a11y violations", async () => {
    const { container } = renderPage(<SettingsPage />, { route: "/settings" });
    await waitForSettled();
    await expectNoA11yViolations(container);
  });
});
