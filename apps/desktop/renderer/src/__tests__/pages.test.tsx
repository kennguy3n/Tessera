import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import HomePage from "../pages/HomePage";
import SettingsPage from "../pages/SettingsPage";
import CreatePage from "../pages/CreatePage";
import SourcesPage from "../pages/SourcesPage";

describe("HomePage", () => {
  it("shows welcome state when no sources or artifacts", async () => {
    render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByText("Welcome to Tessera")).toBeInTheDocument();
    });
  });

  it("shows Add Source button in empty state", async () => {
    render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByText("Add Source")).toBeInTheDocument();
    });
  });

  it("shows sources summary when sources exist", async () => {
    window.tessera.sources.listSources = vi.fn().mockResolvedValue([
      {
        id: "s1",
        sourceType: "local_folder",
        path: "/home/docs",
        status: "connected",
        createdAt: new Date().toISOString(),
        lastIndexed: null,
        fileCount: 10,
      },
    ]);

    render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText("Connected sources")).toBeInTheDocument();
    });

    window.tessera.sources.listSources = vi.fn().mockResolvedValue([]);
  });

  // Phase 10 / Task 27: source-status breakdown — every canonical
  // status renders as its own bucket (`indexed`, `indexing`,
  // `connected`, `error`, `disconnected`), even when the count is
  // zero. Pins the visual contract so a future refactor cannot
  // silently hide buckets that the user relies on for at-a-glance
  // health-checking.
  it("renders a status-breakdown bucket for every canonical SourceStatus", async () => {
    window.tessera.sources.listSources = vi.fn().mockResolvedValue([
      {
        id: "s-ok",
        sourceType: "local_folder",
        path: "/docs/ok",
        status: "indexed",
        createdAt: new Date().toISOString(),
        lastIndexed: new Date().toISOString(),
        fileCount: 12,
      },
      {
        id: "s-ix",
        sourceType: "local_folder",
        path: "/docs/ix",
        status: "indexing",
        createdAt: new Date().toISOString(),
        lastIndexed: null,
        fileCount: 0,
      },
      {
        id: "s-err",
        sourceType: "google_drive",
        path: "drive://...",
        status: "error",
        createdAt: new Date().toISOString(),
        lastIndexed: null,
        fileCount: 0,
      },
      {
        id: "s-err-2",
        sourceType: "google_drive",
        path: "drive://...",
        status: "error",
        createdAt: new Date().toISOString(),
        lastIndexed: null,
        fileCount: 0,
      },
    ]);

    render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("source-status-breakdown")).toBeInTheDocument();
    });

    expect(screen.getByTestId("source-status-indexed")).toHaveTextContent("1");
    expect(screen.getByTestId("source-status-indexing")).toHaveTextContent("1");
    // Even though no `connected` or `disconnected` source exists,
    // the buckets must still render so the user can confirm at a
    // glance that those states are empty rather than wonder if the
    // UI is filtering them out.
    expect(screen.getByTestId("source-status-connected")).toHaveTextContent("0");
    expect(screen.getByTestId("source-status-disconnected")).toHaveTextContent(
      "0",
    );
    expect(screen.getByTestId("source-status-error")).toHaveTextContent("2");

    window.tessera.sources.listSources = vi.fn().mockResolvedValue([]);
  });

  // Phase 10 / Task 27: recent-artifact cards are navigable. Wired
  // through the `Card` component's `onClick` which carries
  // role="button", tabIndex, focus styles, and Enter/Space
  // activation. Test exercises the mouse-click path; keyboard
  // activation is exercised separately by the `Card` component's
  // dedicated test suite.
  it("makes recent-artifact cards navigable to the artifact detail page", async () => {
    window.tessera.artifacts.list = vi.fn().mockResolvedValue([
      {
        id: "art-recent-1",
        title: "Recent Doc",
        artifactType: "document",
        templateId: null,
        content: "",
        citationCount: 0,
        createdAt: new Date(Date.now() - 3600_000).toISOString(),
        updatedAt: new Date().toISOString(),
        version: 2,
      },
    ]);
    // The status-breakdown row needs at least one source for the
    // dashboard view to render instead of the empty welcome state.
    window.tessera.sources.listSources = vi.fn().mockResolvedValue([
      {
        id: "s1",
        sourceType: "local_folder",
        path: "/home/docs",
        status: "indexed",
        createdAt: new Date().toISOString(),
        lastIndexed: new Date().toISOString(),
        fileCount: 1,
      },
    ]);

    render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route
            path="/artifacts/:id"
            element={<CurrentPath />}
          />
        </Routes>
      </MemoryRouter>,
    );

    const card = await screen.findByTestId("recent-artifact-art-recent-1");
    fireEvent.click(card);

    await waitFor(() => {
      expect(screen.getByTestId("current-path")).toHaveTextContent(
        "/artifacts/art-recent-1",
      );
    });

    window.tessera.artifacts.list = vi.fn().mockResolvedValue([]);
    window.tessera.sources.listSources = vi.fn().mockResolvedValue([]);
  });

  // Phase 10 / Task 27: quick-actions row. The four navigation
  // shortcuts (Browse Templates / Tasks / Manage Sources /
  // Settings) must exist on the dashboard view AND route to the
  // right path when clicked. Pins the menu so a refactor that
  // accidentally drops one of the buckets fails CI.
  it("routes each quick-action button to its destination", async () => {
    window.tessera.sources.listSources = vi.fn().mockResolvedValue([
      {
        id: "s1",
        sourceType: "local_folder",
        path: "/home/docs",
        status: "indexed",
        createdAt: new Date().toISOString(),
        lastIndexed: new Date().toISOString(),
        fileCount: 1,
      },
    ]);

    render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/create" element={<CurrentPath />} />
          <Route path="/tasks" element={<CurrentPath />} />
          <Route path="/sources" element={<CurrentPath />} />
          <Route path="/settings" element={<CurrentPath />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText("Browse Templates");
    fireEvent.click(screen.getByText("Browse Templates"));
    await waitFor(() => {
      expect(screen.getByTestId("current-path")).toHaveTextContent("/create");
    });

    window.tessera.sources.listSources = vi.fn().mockResolvedValue([]);
  });
});

describe("SettingsPage", () => {
  it("renders settings sections", async () => {
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByText("General")).toBeInTheDocument();
      expect(screen.getByText("Sources")).toBeInTheDocument();
      expect(screen.getByText("Model Runtime")).toBeInTheDocument();
      expect(screen.getByText("Export")).toBeInTheDocument();
      expect(screen.getByText("About")).toBeInTheDocument();
    });
  });

  it("shows version info in About section", async () => {
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByText("v0.1.0")).toBeInTheDocument();
    });
  });
});

function CurrentPath() {
  const loc = useLocation();
  return <div data-testid="current-path">{loc.pathname}</div>;
}

describe("CreatePage", () => {
  it("shows the template gallery at /create", () => {
    render(
      <MemoryRouter initialEntries={["/create"]}>
        <CreatePage />
      </MemoryRouter>,
    );
    expect(screen.getByText("PRD")).toBeInTheDocument();
    expect(screen.getByText("Product Requirements Document")).toBeInTheDocument();
    expect(screen.queryByText(/Phase 3/i)).not.toBeInTheDocument();
  });

  it("does not show the stale Phase 3 placeholder when a template is selected", async () => {
    render(
      <MemoryRouter initialEntries={["/create?template=prd-v1"]}>
        <CreatePage />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByText(/Create: PRD/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/Phase 3/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/will be available/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Select sources to ground/i)).toBeInTheDocument();
  });

  it("disables Generate until a source is selected, then calls generateFromTemplate and navigates", async () => {
    const source = {
      id: "src-test",
      sourceType: "local_folder" as const,
      path: "/docs",
      status: "connected" as const,
      createdAt: new Date().toISOString(),
      lastIndexed: null,
      fileCount: 3,
    };
    window.tessera.sources.listSources = vi
      .fn()
      .mockResolvedValue([source]);
    const generated = {
      id: "art-new",
      title: "Generated PRD",
      artifactType: "document",
      templateId: "prd-v1",
      content: "",
      citationCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    };
    window.tessera.artifacts.generateFromTemplate = vi
      .fn()
      .mockResolvedValue(generated);

    render(
      <MemoryRouter initialEntries={["/create?template=prd-v1"]}>
        <Routes>
          <Route path="/create" element={<CreatePage />} />
          <Route path="/artifacts/:id" element={<CurrentPath />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText("/docs")).toBeInTheDocument();
    });
    const generateBtn = screen.getByRole("button", { name: /Generate/i });
    expect(generateBtn).toBeDisabled();

    const checkbox = screen.getByRole("checkbox");
    fireEvent.click(checkbox);
    expect(generateBtn).not.toBeDisabled();

    fireEvent.click(generateBtn);

    await waitFor(() => {
      expect(window.tessera.artifacts.generateFromTemplate).toHaveBeenCalledWith(
        "prd-v1",
        ["src-test"],
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("current-path").textContent).toBe(
        "/artifacts/art-new",
      );
    });

    window.tessera.sources.listSources = vi.fn().mockResolvedValue([]);
  });

  it("surfaces an error when no sources are selected", async () => {
    const source = {
      id: "src-test",
      sourceType: "local_folder" as const,
      path: "/docs",
      status: "connected" as const,
      createdAt: new Date().toISOString(),
      lastIndexed: null,
      fileCount: 3,
    };
    window.tessera.sources.listSources = vi
      .fn()
      .mockResolvedValue([source]);

    render(
      <MemoryRouter initialEntries={["/create?template=prd-v1"]}>
        <CreatePage />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByText("/docs")).toBeInTheDocument();
    });
    // Disabled state covers this — the button can't be clicked. Verify
    // explicit "select at least one source" guidance is present.
    const generateBtn = screen.getByRole("button", { name: /Generate/i });
    expect(generateBtn).toBeDisabled();

    window.tessera.sources.listSources = vi.fn().mockResolvedValue([]);
  });

  it("renders all four category tabs with the documented descriptions", () => {
    render(
      <MemoryRouter initialEntries={["/create"]}>
        <CreatePage />
      </MemoryRouter>,
    );
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual([
      "Create",
      "Analyze",
      "Plan",
      "Approve",
    ]);
    // Default tab is Create — its description text drives the page header.
    expect(
      screen.getByText(/Generate documents, slides, infographics/),
    ).toBeInTheDocument();
  });

  it("Analyze tab surfaces the three workflow shortcuts at the top", () => {
    render(
      <MemoryRouter initialEntries={["/create"]}>
        <CreatePage />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Analyze" }));
    // Each workflow shows its friendly name…
    expect(screen.getByText("Summarize sources")).toBeInTheDocument();
    expect(screen.getByText("Generate report")).toBeInTheDocument();
    expect(screen.getByText("Analyze spreadsheet")).toBeInTheDocument();
    // …and is tagged with the "Workflow" pill.
    expect(screen.getAllByText("Workflow")).toHaveLength(3);
  });

  it("clicking a workflow card opens the runner with the workflow's friendly name", async () => {
    window.tessera.sources.listSources = vi.fn().mockResolvedValue([]);

    render(
      <MemoryRouter initialEntries={["/create"]}>
        <CreatePage />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Analyze" }));
    fireEvent.click(screen.getByText("Analyze spreadsheet"));

    // The runner page renders with the workflow name, NOT the underlying
    // template name ("Report").
    await waitFor(() => {
      expect(
        screen.getByText(/Create: Analyze spreadsheet/),
      ).toBeInTheDocument();
    });
    // The workflow's sourceHint is shown as the page description.
    expect(
      screen.getByText(/Pick a Sheet you've already imported/),
    ).toBeInTheDocument();
  });

  it("workflow shortcut keeps its workflow description after the underlying template async-loads", async () => {
    // workflow shortcuts ("Summarize sources", "Generate report")
    // share `report-v1` as their underlying template. Without
    // workflow-aware precedence, once `templates.get('report-v1')`
    // resolved with description "Analytical report", the generic
    // template copy would replace the workflow's friendly text in
    // the page header — but only *after* the async fetch landed,
    // producing a confusing flicker. The fix gives workflow
    // `localItem.description` priority over `template.description`,
    // matching the parallel `displayName` precedence.
    window.tessera.sources.listSources = vi.fn().mockResolvedValue([]);
    window.tessera.templates.get = vi.fn().mockResolvedValue({
      id: "report-v1",
      name: "Report",
      description: "Analytical report",
      version: "1",
      category: "documents",
    });

    render(
      <MemoryRouter initialEntries={["/create"]}>
        <CreatePage />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Analyze" }));
    fireEvent.click(screen.getByText("Summarize sources"));

    // After the async template fetch resolves, the workflow's
    // friendly description must still be on screen — and the generic
    // "Analytical report" template copy must NOT.
    await waitFor(() => {
      expect(
        screen.getByText(/draft a grounded summary report/),
      ).toBeInTheDocument();
    });
    expect(screen.queryByText("Analytical report")).not.toBeInTheDocument();
  });
});

describe("SourcesPage", () => {
  it("prunes selectedIds when a selected source is removed (Compare counter drops from 2/2 to 1/2)", async () => {
    // Before the fix: selecting two sources, then removing one via the
    // confirm-Remove modal, left the removed source's id in
    // `selectedIds`. `refresh()` re-fetched the list (now showing one
    // source) but the Compare button still read "Compare (2/2)" and
    // stayed enabled — clicking it dispatched
    // `artifacts:compareSources(stale-id, kept-id)`, which the
    // backend would reject.
    // After the fix: a `useEffect` watches `sources` and prunes any
    // id in `selectedIds` that's not present in the current list.
    // This test installs two sources, selects both, removes one,
    // and asserts the counter drops from 2/2 to 1/2 and the button
    // becomes disabled.
    const s1 = {
      id: "src-keep",
      sourceType: "local_folder" as const,
      path: "/docs/keep",
      status: "connected" as const,
      createdAt: new Date().toISOString(),
      lastIndexed: null,
      fileCount: 1,
    };
    const s2 = {
      id: "src-remove",
      sourceType: "local_folder" as const,
      path: "/docs/remove",
      status: "connected" as const,
      createdAt: new Date().toISOString(),
      lastIndexed: null,
      fileCount: 1,
    };

    // First refresh returns both; after we remove s2 the next refresh
    // returns only s1. `useSourceList` calls `listSources` once on
    // mount and again after `refresh()` so two mock values are enough.
    const listSources = vi
      .fn()
      .mockResolvedValueOnce([s1, s2])
      .mockResolvedValue([s1]);
    const removeSource = vi.fn().mockResolvedValue(undefined);
    window.tessera.sources.listSources = listSources;
    window.tessera.sources.removeSource = removeSource;

    render(
      <MemoryRouter>
        <SourcesPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText("/docs/keep")).toBeInTheDocument();
      expect(screen.getByText("/docs/remove")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("source-select-src-keep"));
    fireEvent.click(screen.getByTestId("source-select-src-remove"));

    // Precondition: Compare button shows 2/2 and is enabled.
    const compareBtn = screen.getByTestId("compare-sources");
    await waitFor(() => {
      expect(compareBtn.textContent).toMatch(/Compare \(2\/2\)/);
    });
    expect(compareBtn).not.toBeDisabled();

    // Open the confirm-Remove modal for s2 by clicking its per-card
    // Remove button. There are two "Remove" buttons rendered (one
    // per source card); s2's card is rendered second so it's at
    // index 1.
    const cardRemoveButtons = screen.getAllByRole("button", { name: "Remove" });
    fireEvent.click(cardRemoveButtons[1]);

    // The modal renders its own "Remove" confirmation button. Click
    // the last "Remove" in DOM order (the modal's).
    await waitFor(() => {
      const buttons = screen.getAllByRole("button", { name: "Remove" });
      // The modal adds a 3rd button (2 card + 1 modal).
      expect(buttons.length).toBeGreaterThan(cardRemoveButtons.length);
    });
    const allRemove = screen.getAllByRole("button", { name: "Remove" });
    fireEvent.click(allRemove[allRemove.length - 1]);

    await waitFor(() => {
      expect(removeSource).toHaveBeenCalledWith("src-remove");
    });

    // After the refresh, s2 is gone from the list AND from
    // selectedIds, so the counter drops to 1/2 and the button is
    // disabled.
    await waitFor(() => {
      expect(screen.queryByText("/docs/remove")).not.toBeInTheDocument();
    });
    await waitFor(() => {
      const c = screen.getByTestId("compare-sources");
      expect(c.textContent).toMatch(/Compare \(1\/2\)/);
      expect(c).toBeDisabled();
    });

    window.tessera.sources.listSources = vi.fn().mockResolvedValue([]);
    window.tessera.sources.removeSource = vi.fn().mockResolvedValue(undefined);
  });
});
