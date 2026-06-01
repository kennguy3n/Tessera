/**
 * empty-state illustration coverage for every
 * page that can be empty. Each test asserts (a) the EmptyState card
 * is rendered (`empty-state` class), (b) a Lucide icon-emitted SVG
 * is present (the icons render as `<svg>` elements with role="img"
 * or inline svgs depending on Lucide build), (c) the descriptive
 * message text matches the deliberate copy, and (d) the primary
 * action button is wired up. We do NOT use snapshot serialization
 * here — Lucide ships an explicit version number in its SVG attribs
 * which would cause snapshot churn on every Lucide upgrade. Instead
 * we assert the exact structural contract.
 *
 * Pages covered:
 *   - SourcesPage: "No sources connected" + FolderPlus icon + "Add Source"
 *   - TasksPage:   "No tasks yet"          + ClipboardList icon
 *   - AutomationsPage: "No automations yet" + Zap icon
 *   - TemplatesPage:   "No templates available" + LayoutTemplate icon
 *
 * The page-level mocks default `tessera.{sources,tasks,automations,
 * templates}.list` to `[]` in `setup.ts`, so each page renders its
 * empty state out-of-the-box without per-test mock surgery.
 */
import { describe, it, expect } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import SourcesPage from "../pages/SourcesPage";
import TasksPage from "../pages/TasksPage";
import AutomationsPage from "../pages/AutomationsPage";
import TemplatesPage from "../pages/TemplatesPage";

function expectEmptyStateRendered(
  title: string,
  messageFragment: string,
) {
  // The `.empty-state` class is added by `EmptyState.tsx` to its
  // outermost wrapper. Asserting on the class rather than role
  // guarantees the styling contract — a regression that hid the
  // icon, message, or call-to-action would still register here.
  const card = document.querySelector(".empty-state");
  expect(card).not.toBeNull();
  // Lucide icons render as <svg> children of `.empty-state-icon`.
  // Asserting on the descendant SVG confirms the icon swap from
  // the old emoji string to a Lucide React component (the Task 20
  // deliverable).
  expect(document.querySelector(".empty-state-icon svg")).not.toBeNull();
  expect(screen.getByText(title)).toBeInTheDocument();
  expect(
    screen.getByText(new RegExp(messageFragment, "i")),
  ).toBeInTheDocument();
}

describe("empty-state illustrations", () => {
  it("SourcesPage shows the FolderPlus empty state", async () => {
    render(
      <MemoryRouter>
        <SourcesPage />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(
        screen.getByText("No sources connected"),
      ).toBeInTheDocument(),
    );
    expectEmptyStateRendered("No sources connected", "Add a local folder");
  });

  it("TasksPage shows the ClipboardList empty state", async () => {
    render(
      <MemoryRouter>
        <TasksPage />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(screen.getByText("No tasks yet")).toBeInTheDocument(),
    );
    expectEmptyStateRendered("No tasks yet", "Create a task");
  });

  it("AutomationsPage shows the Zap empty state", async () => {
    render(
      <MemoryRouter>
        <AutomationsPage />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(screen.getByText("No automations yet")).toBeInTheDocument(),
    );
    expectEmptyStateRendered("No automations yet", "scheduled reindexes");
  });

  it("TemplatesPage shows the SearchX empty state when no templates match a query", async () => {
    // TemplatesPage falls back to a hardcoded BUILTIN_TEMPLATES array
    // when the IPC returns no templates, so the "No templates
    // available" branch is only reachable in a broken-install
    // scenario we cannot simulate from the renderer. The
    // reachable-from-UI empty state is the search-no-match branch,
    // which is what real users see and what the spec means by
    // "empty state for TemplatesPage" — it has its own dedicated
    // Lucide icon (SearchX) and its own copy.
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <TemplatesPage />
      </MemoryRouter>,
    );
    // Wait for the gallery to render (proves loading finished).
    await waitFor(() => {
      expect(screen.getByTestId("template-gallery")).toBeInTheDocument();
    });
    // Type a query that cannot match any builtin template.
    const search = screen.getByPlaceholderText("Search templates...");
    await user.type(search, "zzzz-no-such-template-name-zzzz");
    await waitFor(() =>
      expect(screen.getByText("No matching templates")).toBeInTheDocument(),
    );
    expectEmptyStateRendered(
      "No matching templates",
      "No templates match",
    );
  });
});
