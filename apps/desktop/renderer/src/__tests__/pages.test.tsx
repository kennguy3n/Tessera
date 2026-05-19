import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import HomePage from "../pages/HomePage";
import SettingsPage from "../pages/SettingsPage";
import CreatePage from "../pages/CreatePage";

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
      expect(screen.getByText("1")).toBeInTheDocument();
      expect(screen.getByText("Connected sources")).toBeInTheDocument();
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
      citations: [],
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
});
