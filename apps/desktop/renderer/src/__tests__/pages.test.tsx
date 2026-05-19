import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import HomePage from "../pages/HomePage";
import SettingsPage from "../pages/SettingsPage";

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
