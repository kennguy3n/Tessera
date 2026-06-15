import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  within,
} from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import HomePage from "../pages/HomePage";
import SettingsPage from "../pages/SettingsPage";
import CreatePage from "../pages/CreatePage";
import SourcesPage from "../pages/SourcesPage";
import { __resetSettingsStoreForTests } from "../hooks/useSettings";
import type { TemplateInfo } from "../types/ipc";

/**
 * Switch the Create page from its default guided wizard into the full
 * tabbed gallery by clicking the always-present "Show all templates"
 * action. Gallery-specific assertions below run after this so they
 * exercise the same gallery the wizard now hides behind a click.
 */
function showFullGallery() {
  fireEvent.click(screen.getByRole("button", { name: /show all templates/i }));
}

/**
 * Build a fully-typed {@link TemplateInfo} fixture (mirrors the N-API
 * bridge surface) so registry-driven CreatePage tests can stub
 * `window.tessera.templates.list()` without `any`.
 */
function templateInfo(
  overrides: Partial<TemplateInfo> & Pick<TemplateInfo, "id" | "name">,
): TemplateInfo {
  return {
    artifactType: "document",
    description: "",
    sectionCount: 1,
    exportFormats: ["pdf"],
    industry: [],
    locale: "en",
    category: "documents",
    ...overrides,
  };
}

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

  // source-status breakdown — every canonical
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
    expect(screen.getByTestId("source-status-connected")).toHaveTextContent(
      "0",
    );
    expect(screen.getByTestId("source-status-disconnected")).toHaveTextContent(
      "0",
    );
    expect(screen.getByTestId("source-status-error")).toHaveTextContent("2");

    window.tessera.sources.listSources = vi.fn().mockResolvedValue([]);
  });

  // recent-artifact cards are navigable. Wired
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
          <Route path="/artifacts/:id/edit" element={<CurrentPath />} />
        </Routes>
      </MemoryRouter>,
    );

    const card = await screen.findByTestId("recent-artifact-art-recent-1");
    fireEvent.click(card);

    await waitFor(() => {
      expect(screen.getByTestId("current-path")).toHaveTextContent(
        "/artifacts/art-recent-1/edit",
      );
    });

    window.tessera.artifacts.list = vi.fn().mockResolvedValue([]);
    window.tessera.sources.listSources = vi.fn().mockResolvedValue([]);
  });

  // quick-actions row. The four navigation
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

  it("persists the simplified-nav and auto-download toggles on Save", async () => {
    const updateSpy = window.tessera.settings.update as ReturnType<
      typeof vi.fn
    >;
    updateSpy.mockClear();

    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );

    const simplified = await screen.findByTestId("settings-simplified-nav");
    const autoDownload = screen.getByTestId("settings-auto-download-model");
    // Defaults reflect the loaded settings (both on).
    expect(simplified).toBeChecked();
    expect(autoDownload).toBeChecked();

    fireEvent.click(simplified);
    fireEvent.click(autoDownload);
    // The page-level Save lives in the PageHeader (rendered first);
    // per-card panels also render their own Save buttons.
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          simplifiedNav: false,
          autoDownloadModel: false,
        }),
      );
    });
  });
});

function CurrentPath() {
  const loc = useLocation();
  return <div data-testid="current-path">{loc.pathname}</div>;
}

describe("CreatePage", () => {
  beforeEach(() => {
    // Each case starts from a fresh-install state: the guided wizard
    // is the default (`createPageMode: "wizard"`). Reset the shared
    // settings store so a prior test's mode toggle doesn't leak in.
    __resetSettingsStoreForTests();
    // Default the text-model probe to "installed" so the runner shows
    // its AI-enhanced path (button labelled "Generate"). The
    // extraction-only test overrides this with a null model.
    window.tessera.runtime.getCurrentModel = vi.fn().mockResolvedValue({
      modelId: "text-model-v1",
      capability: "text",
      installedAt: new Date().toISOString(),
      sizeBytes: 1,
    });
    // The gallery derives its cards from the registry; reset the list
    // each case so a prior test's fixtures don't leak (the bridge mock
    // is a shared singleton — see setup.ts).
    window.tessera.templates.list = vi.fn().mockResolvedValue([]);
    window.tessera.templates.get = vi.fn().mockResolvedValue(null);
  });

  it("defaults to the guided intent wizard at /create", () => {
    render(
      <MemoryRouter initialEntries={["/create"]}>
        <CreatePage />
      </MemoryRouter>,
    );
    expect(screen.getByText("What do you need?")).toBeInTheDocument();
    expect(screen.getByText("Write a document")).toBeInTheDocument();
    expect(screen.getByText("Make a presentation")).toBeInTheDocument();
    // The full gallery is hidden until the user opts in.
    expect(
      screen.queryByRole("tab", { name: "Analyze" }),
    ).not.toBeInTheDocument();
  });

  it("walks intent → curated templates → runner", async () => {
    window.tessera.sources.listSources = vi.fn().mockResolvedValue([]);
    render(
      <MemoryRouter initialEntries={["/create"]}>
        <Routes>
          <Route path="/create" element={<CreatePage />} />
        </Routes>
      </MemoryRouter>,
    );
    // Step 1 → pick an intent.
    fireEvent.click(screen.getByText("Write a document"));
    // Step 2 → curated templates for documents.
    expect(screen.getByText("What's it for?")).toBeInTheDocument();
    expect(screen.getByText("PRD")).toBeInTheDocument();
    // Pick a template → runner opens for that id.
    fireEvent.click(screen.getByText("PRD"));
    await waitFor(() => {
      expect(screen.getByText(/Create: PRD/)).toBeInTheDocument();
    });
  });

  it("shows the full gallery after clicking 'Show all templates'", async () => {
    render(
      <MemoryRouter initialEntries={["/create"]}>
        <CreatePage />
      </MemoryRouter>,
    );
    showFullGallery();
    // Curated cards render synchronously from the (empty) registry…
    expect(screen.getByText("PRD")).toBeInTheDocument();
    expect(
      screen.getByText("Product Requirements Document"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Phase 3/i)).not.toBeInTheDocument();
    // …then let the registry fetch settle so its state update lands
    // inside act() (the empty mock leaves the curated cards unchanged).
    await waitFor(() =>
      expect(window.tessera.templates.list).toHaveBeenCalled(),
    );
  });

  it("does not show the legacy placeholder copy when a template is selected", async () => {
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
    window.tessera.sources.listSources = vi.fn().mockResolvedValue([source]);
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
          <Route path="/artifacts/:id/edit" element={<CurrentPath />} />
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
      expect(
        window.tessera.artifacts.generateFromTemplate,
      ).toHaveBeenCalledWith("prd-v1", ["src-test"]);
    });
    // /artifacts/:id is not a registered route — the app routes generated
    // artifacts straight to the editor (/artifacts/:id/edit), matching
    // HomePage's recent-artifact cards and the command palette.
    await waitFor(() => {
      expect(screen.getByTestId("current-path").textContent).toBe(
        "/artifacts/art-new/edit",
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
    window.tessera.sources.listSources = vi.fn().mockResolvedValue([source]);

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

  it("surfaces concept-graph suggestions and includes them on click", async () => {
    const sourceA = {
      id: "11111111-1111-4111-8111-111111111111",
      sourceType: "local_folder" as const,
      path: "/docs/a",
      status: "connected" as const,
      createdAt: new Date().toISOString(),
      lastIndexed: null,
      fileCount: 2,
    };
    const sourceB = {
      id: "22222222-2222-4222-8222-222222222222",
      sourceType: "local_folder" as const,
      path: "/docs/b",
      status: "connected" as const,
      createdAt: new Date().toISOString(),
      lastIndexed: null,
      fileCount: 1,
    };
    window.tessera.sources.listSources = vi
      .fn()
      .mockResolvedValue([sourceA, sourceB]);
    // The substrate suggests source B (co-occurs with A under "Acme
    // Corp"). Once B is selected the suggestion's only id is selected
    // and the panel must disappear.
    window.tessera.substrate.suggestRelatedSources = vi
      .fn()
      .mockResolvedValue([
        { entity: "Acme Corp", sourceIds: [sourceB.id], score: 0.9 },
      ]);

    render(
      <MemoryRouter initialEntries={["/create?template=prd-v1"]}>
        <Routes>
          <Route path="/create" element={<CreatePage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText("/docs/a")).toBeInTheDocument();
    });

    // No suggestions until the user selects a source (empty selection
    // short-circuits without an IPC round-trip).
    expect(
      screen.queryByTestId("create-related-suggestions"),
    ).not.toBeInTheDocument();

    // Select source A → substrate is queried with [A].
    fireEvent.click(screen.getByLabelText(/\/docs\/a/i));
    await waitFor(() => {
      expect(
        window.tessera.substrate.suggestRelatedSources,
      ).toHaveBeenCalledWith([sourceA.id], 5);
    });

    const panel = await screen.findByTestId("create-related-suggestions");
    expect(
      within(panel).getByText(/You have 1 more source about/i),
    ).toBeInTheDocument();
    expect(within(panel).getByText("Acme Corp")).toBeInTheDocument();

    // Including the suggestion checks source B and removes the panel.
    fireEvent.click(
      within(panel).getByRole("button", {
        name: /include 1 source about acme corp/i,
      }),
    );
    await waitFor(() => {
      expect(
        screen.queryByTestId("create-related-suggestions"),
      ).not.toBeInTheDocument();
    });
    const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(checkboxes.every((c) => c.checked)).toBe(true);

    window.tessera.sources.listSources = vi.fn().mockResolvedValue([]);
    window.tessera.substrate.suggestRelatedSources = vi
      .fn()
      .mockResolvedValue([]);
  });

  it("renders all four category tabs with the documented descriptions", async () => {
    render(
      <MemoryRouter initialEntries={["/create"]}>
        <CreatePage />
      </MemoryRouter>,
    );
    showFullGallery();
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
    await waitFor(() =>
      expect(window.tessera.templates.list).toHaveBeenCalled(),
    );
  });

  it("Analyze tab surfaces the three workflow shortcuts at the top", async () => {
    render(
      <MemoryRouter initialEntries={["/create"]}>
        <CreatePage />
      </MemoryRouter>,
    );
    showFullGallery();
    fireEvent.click(screen.getByRole("tab", { name: "Analyze" }));
    // Each workflow shows its friendly name…
    expect(screen.getByText("Summarize sources")).toBeInTheDocument();
    expect(screen.getByText("Generate report")).toBeInTheDocument();
    expect(screen.getByText("Analyze spreadsheet")).toBeInTheDocument();
    // …and is tagged with the "Workflow" pill.
    expect(screen.getAllByText("Workflow")).toHaveLength(3);
    await waitFor(() =>
      expect(window.tessera.templates.list).toHaveBeenCalled(),
    );
  });

  it("clicking a workflow card opens the runner with the workflow's friendly name", async () => {
    window.tessera.sources.listSources = vi.fn().mockResolvedValue([]);

    render(
      <MemoryRouter initialEntries={["/create"]}>
        <CreatePage />
      </MemoryRouter>,
    );
    showFullGallery();
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
    showFullGallery();
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

  it("auto-surfaces an uncurated registry template as a gallery card", async () => {
    // `field-journal-v1` is NOT in the curated CATEGORIES overlay — it
    // appears purely because the registry returned it, proving a new
    // YAML surfaces with no CreatePage edit. Documents default to the
    // Create tab.
    window.tessera.templates.list = vi.fn().mockResolvedValue([
      templateInfo({
        id: "field-journal-v1",
        name: "Field Journal",
        description: "Structured field observation log",
        category: "documents",
      }),
    ]);
    render(
      <MemoryRouter initialEntries={["/create"]}>
        <CreatePage />
      </MemoryRouter>,
    );
    showFullGallery();
    expect(await screen.findByText("Field Journal")).toBeInTheDocument();
    expect(
      screen.getByText("Structured field observation log"),
    ).toBeInTheDocument();
  });

  it("routes an uncurated sheet template to the Plan tab, not Create", async () => {
    window.tessera.templates.list = vi.fn().mockResolvedValue([
      templateInfo({
        id: "telemetry-grid-v1",
        name: "Telemetry Grid",
        description: "Sensor telemetry sheet",
        artifactType: "sheet",
        category: "sheets",
      }),
    ]);
    render(
      <MemoryRouter initialEntries={["/create"]}>
        <CreatePage />
      </MemoryRouter>,
    );
    showFullGallery();
    // Sheets/bases auto-surface under Plan…
    fireEvent.click(screen.getByRole("tab", { name: "Plan" }));
    expect(await screen.findByText("Telemetry Grid")).toBeInTheDocument();
    // …and are absent from the default Create tab.
    fireEvent.click(screen.getByRole("tab", { name: "Create" }));
    expect(screen.queryByText("Telemetry Grid")).not.toBeInTheDocument();
  });

  it("overlays registry industry tags onto curated cards and filters by them", async () => {
    window.tessera.templates.list = vi.fn().mockResolvedValue([
      templateInfo({
        id: "prd-v1",
        name: "PRD",
        industry: ["healthcare"],
        category: "documents",
      }),
    ]);
    render(
      <MemoryRouter initialEntries={["/create"]}>
        <CreatePage />
      </MemoryRouter>,
    );
    showFullGallery();
    // The industry tag is rendered from the registry overlay, not the
    // curated literal (which no longer carries industry values).
    expect(await screen.findByText("healthcare")).toBeInTheDocument();
    // Filtering to a non-matching industry hides the now-tagged PRD card
    // and the industry-agnostic curated cards alike.
    fireEvent.change(screen.getByTestId("industry-filter"), {
      target: { value: "legal" },
    });
    expect(screen.queryByText("PRD")).not.toBeInTheDocument();
    expect(screen.queryByText("Proposal")).not.toBeInTheDocument();
    // Selecting the matching industry brings PRD back.
    fireEvent.change(screen.getByTestId("industry-filter"), {
      target: { value: "healthcare" },
    });
    expect(screen.getByText("PRD")).toBeInTheDocument();
  });

  it("derives available locales and resolves the localized id on click", async () => {
    const getSpy = vi.fn().mockResolvedValue(null);
    window.tessera.templates.get = getSpy;
    window.tessera.sources.listSources = vi.fn().mockResolvedValue([]);
    window.tessera.templates.list = vi.fn().mockResolvedValue([
      templateInfo({ id: "prd-v1", name: "PRD", category: "documents" }),
      templateInfo({
        id: "prd-v1-es",
        name: "PRD (Spanish)",
        locale: "es",
        category: "documents",
      }),
      // Uncurated English doc used purely as a "registry has resolved"
      // signal so the locale-filter assertion is not racy.
      templateInfo({
        id: "ledger-note-v1",
        name: "Ledger Note",
        category: "documents",
      }),
    ]);
    render(
      <MemoryRouter initialEntries={["/create"]}>
        <Routes>
          <Route path="/create" element={<CreatePage />} />
        </Routes>
      </MemoryRouter>,
    );
    showFullGallery();
    // Wait until the async list lands (the uncurated card proves it),
    // so the `prd-v1-es` variant has been grouped into PRD's locales.
    await screen.findByText("Ledger Note");
    fireEvent.change(screen.getByTestId("locale-filter"), {
      target: { value: "es" },
    });
    fireEvent.click(screen.getByText("PRD"));
    // The localized variant id is resolved from the derived locales and
    // handed to the runner's template fetch.
    await waitFor(() => expect(getSpy).toHaveBeenCalledWith("prd-v1-es"));
  });

  it("falls back to an extraction-only runner when no text model is installed", async () => {
    // No model in the text slot → the runner must set source-based
    // expectations: a "Source-based" badge, the "Create from sources"
    // button label, and an inline explanation.
    window.tessera.runtime.getCurrentModel = vi.fn().mockResolvedValue(null);
    window.tessera.sources.listSources = vi.fn().mockResolvedValue([]);

    render(
      <MemoryRouter initialEntries={["/create?template=prd-v1"]}>
        <CreatePage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("create-model-badge")).toHaveTextContent(
        "Source-based",
      );
    });
    expect(
      screen.getByRole("button", { name: /create from sources/i }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("create-extraction-note")).toBeInTheDocument();
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

  it("opens the ComparisonResultModal in-place instead of navigating after a successful compare", async () => {
    // Regression test: handleCompare must surface the
    // structured CompareSourcesResult through the new modal rather
    // than calling navigate(/artifacts/<id>) which was the old
    // behaviour. The modal lets the user inspect themes and either
    // dismiss or click "Open artifact" — keeping the comparison
    // flow self-contained on SourcesPage.
    const s1 = {
      id: "src-a",
      sourceType: "local_folder" as const,
      path: "/docs/a",
      status: "connected" as const,
      createdAt: new Date().toISOString(),
      lastIndexed: null,
      fileCount: 1,
    };
    const s2 = {
      id: "src-b",
      sourceType: "local_folder" as const,
      path: "/docs/b",
      status: "connected" as const,
      createdAt: new Date().toISOString(),
      lastIndexed: null,
      fileCount: 1,
    };
    window.tessera.sources.listSources = vi.fn().mockResolvedValue([s1, s2]);

    const compareSpy = vi.fn().mockResolvedValue({
      artifact: {
        id: "art-cmp",
        title: "Source Comparison",
        artifactType: "document",
        templateId: null,
        content: "# Source Comparison\n\n",
        citationCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1,
      },
      comparison: {
        similarityScore: 0.62,
        commonThemes: [{ label: "indexing pipeline", frequency: 9 }],
        uniqueToA: [{ label: "alpha-only feature", frequency: 3 }],
        uniqueToB: [{ label: "beta-only feature", frequency: 4 }],
      },
      labelA: "a",
      labelB: "b",
    });
    window.tessera.artifacts.compareSources = compareSpy;

    render(
      <MemoryRouter>
        <SourcesPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText("/docs/a")).toBeInTheDocument();
      expect(screen.getByText("/docs/b")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("source-select-src-a"));
    fireEvent.click(screen.getByTestId("source-select-src-b"));
    fireEvent.click(screen.getByTestId("compare-sources"));

    await waitFor(() => {
      expect(compareSpy).toHaveBeenCalledWith("src-a", "src-b");
    });
    // Modal shows up with the bridge-side friendly labels and
    // structured themes — proves the wiring carries the
    // CompareSourcesResult fields through.
    await waitFor(() => {
      expect(screen.getByText("Comparison: a vs b")).toBeInTheDocument();
    });
    expect(
      screen.getByTestId("comparison-modal-common-item-indexing pipeline"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("comparison-modal-similarity")).toHaveTextContent(
      "62%",
    );
  });

  it("renders a source-type glyph on every row", async () => {
    // Integration pin for the new `sourceTypeIcon` helper applied
    // at the SourcesPage row level: each source kind must surface
    // its glyph + aria-label so a user scanning the list can tell
    // local folders, files, and KChat channels apart without
    // reading the description line.
    const folder = {
      id: "src-folder",
      sourceType: "local_folder" as const,
      path: "/docs/folder",
      status: "connected" as const,
      createdAt: new Date().toISOString(),
      lastIndexed: null,
      fileCount: 1,
    };
    const file = {
      id: "src-file",
      sourceType: "local_file" as const,
      path: "/docs/file.md",
      status: "connected" as const,
      createdAt: new Date().toISOString(),
      lastIndexed: null,
      fileCount: 1,
    };
    const kchat = {
      id: "src-kchat",
      sourceType: "kchat" as const,
      path: "/home/u/.tessera/kchat-channels/chid26charactersaaaaaaaaaa",
      status: "connected" as const,
      createdAt: new Date().toISOString(),
      lastIndexed: null,
      fileCount: 0,
    };
    window.tessera.sources.listSources = vi
      .fn()
      .mockResolvedValue([folder, file, kchat]);

    render(
      <MemoryRouter>
        <SourcesPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText("/docs/folder")).toBeInTheDocument();
      expect(screen.getByText("/docs/file.md")).toBeInTheDocument();
      expect(
        screen.getByText(
          "/home/u/.tessera/kchat-channels/chid26charactersaaaaaaaaaa",
        ),
      ).toBeInTheDocument();
    });

    const folderIcon = screen.getByTestId("source-icon-src-folder");
    expect(folderIcon).toHaveAttribute("aria-label", "Local folder source");
    expect(folderIcon).toHaveAttribute("role", "img");
    expect(folderIcon.textContent).toBe("📁");

    const fileIcon = screen.getByTestId("source-icon-src-file");
    expect(fileIcon).toHaveAttribute("aria-label", "Local file source");
    expect(fileIcon.textContent).toBe("📄");

    const kchatIcon = screen.getByTestId("source-icon-src-kchat");
    expect(kchatIcon).toHaveAttribute("aria-label", "KChat channel source");
    expect(kchatIcon.textContent).toBe("💬");
  });
});
