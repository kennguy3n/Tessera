/**
 * Phase 15 Task 19 — OnboardingWizard tests.
 *
 * Coverage:
 *   1. Renders step 1 (Add source) on mount.
 *   2. Primary CTA advances to step 2 (Pick a template) AND navigates.
 *   3. Featured-template click navigates to /create?template=… and lands
 *      on step 3 (final "Your workspace is ready").
 *   4. Final-step "Finish" calls settings.update({onboardingCompleted})
 *      THEN invokes onDismiss.
 *   5. Skip button on step 1 ALSO persists onboardingCompleted before
 *      onDismiss (the "ESC == Skip" path is the same code, so covering
 *      Skip implicitly covers ESC).
 *
 * Why mock `react-router-dom`'s `useNavigate`: the wizard relies on it
 * for the "Add a folder" / "Browse templates" / template-card CTAs.
 * We capture nav calls via a spy so we can assert the route AND the
 * accompanying step transition.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import OnboardingWizard from "../components/OnboardingWizard";

const navigateSpy = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>(
      "react-router-dom",
    );
  return {
    ...actual,
    useNavigate: () => navigateSpy,
  };
});

describe("OnboardingWizard", () => {
  beforeEach(() => {
    navigateSpy.mockReset();
    // Re-arm the settings.update spy so the "persist before dismiss"
    // assertion sees a fresh call list per test. The setup mock returns
    // a resolved promise so we don't need to override the implementation.
    (window.tessera.settings.update as ReturnType<typeof vi.fn>).mockClear();
  });

  function renderWizard(onDismiss = vi.fn()) {
    return {
      onDismiss,
      ...render(
        <MemoryRouter>
          <OnboardingWizard onDismiss={onDismiss} />
        </MemoryRouter>,
      ),
    };
  }

  it("renders step 1 (Add a folder) on mount", () => {
    renderWizard();
    expect(screen.getByText("Add your first source")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add a folder" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Skip" })).toBeTruthy();
  });

  it("primary CTA on step 1 navigates to /sources AND advances to step 2", async () => {
    renderWizard();
    fireEvent.click(screen.getByRole("button", { name: "Add a folder" }));
    expect(navigateSpy).toHaveBeenCalledWith("/sources");
    // Step 2 copy now visible.
    await waitFor(() => {
      expect(screen.getByText("Pick a template")).toBeTruthy();
    });
  });

  it("featured-template click routes to /create with id AND lands on step 3", async () => {
    renderWizard();
    // Advance to step 2.
    fireEvent.click(screen.getByRole("button", { name: "Add a folder" }));
    await waitFor(() => screen.getByText("Pick a template"));
    // Click first featured template (PRD).
    fireEvent.click(screen.getByText("PRD").closest("button")!);
    expect(navigateSpy).toHaveBeenLastCalledWith("/create?template=prd-v1");
    await waitFor(() => {
      expect(screen.getByText("Your workspace is ready")).toBeTruthy();
    });
  });

  it("Finish on step 3 persists onboardingCompleted before onDismiss", async () => {
    const { onDismiss } = renderWizard();
    // Advance to step 3 by clicking primary on step 1 then step 2.
    fireEvent.click(screen.getByRole("button", { name: "Add a folder" }));
    await waitFor(() => screen.getByText("Pick a template"));
    fireEvent.click(screen.getByRole("button", { name: "Browse templates" }));
    await waitFor(() => screen.getByText("Your workspace is ready"));
    fireEvent.click(screen.getByRole("button", { name: "Finish" }));
    await waitFor(() => {
      expect(window.tessera.settings.update).toHaveBeenCalledWith({
        onboardingCompleted: true,
      });
      expect(onDismiss).toHaveBeenCalledTimes(1);
    });
  });

  it("Skip on step 1 ALSO persists onboardingCompleted before onDismiss", async () => {
    const { onDismiss } = renderWizard();
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    await waitFor(() => {
      expect(window.tessera.settings.update).toHaveBeenCalledWith({
        onboardingCompleted: true,
      });
      expect(onDismiss).toHaveBeenCalledTimes(1);
    });
  });
});
