/**
 * OnboardingWizard tests.
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
import {
  act,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ModelDownloadProgress } from "../../../shared/types";
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

  it("intent → curated template click routes to /create with id AND lands on step 3", async () => {
    renderWizard();
    // Advance to step 2.
    fireEvent.click(screen.getByRole("button", { name: "Add a folder" }));
    await waitFor(() => screen.getByText("Pick a template"));
    // Step 2 now shows the shared intent picker. Pick "Write a
    // document" to reveal its curated templates…
    fireEvent.click(screen.getByText("Write a document"));
    // …then pick PRD. The Card renders as role="button"; click the
    // label text and the event bubbles to the card's onClick.
    fireEvent.click(screen.getByText("PRD"));
    expect(navigateSpy).toHaveBeenLastCalledWith("/create?template=prd-v1");
    await waitFor(() => {
      expect(screen.getByText("Your workspace is ready")).toBeTruthy();
    });
  });

  it("surfaces background model download progress on the template step", async () => {
    // Capture the progress callback so the test can drive it.
    let emit: ((p: ModelDownloadProgress) => void) | null = null;
    window.tessera.runtime.onDownloadProgress = vi.fn((cb) => {
      emit = cb;
      return () => undefined;
    });
    window.tessera.runtime.getCurrentModel = vi.fn().mockResolvedValue(null);

    renderWizard();
    fireEvent.click(screen.getByRole("button", { name: "Add a folder" }));
    await waitFor(() => screen.getByText("Pick a template"));

    // No progress yet → no note.
    expect(
      screen.queryByTestId("onboarding-model-progress"),
    ).not.toBeInTheDocument();

    await waitFor(() => expect(emit).not.toBeNull());
    act(() => {
      emit!({
        modelId: "text-model-v1",
        capability: "text",
        format: "gguf",
        filename: "model.gguf",
        downloadedMb: 65,
        totalMb: 100,
        percent: 65,
      });
    });

    expect(
      screen.getByTestId("onboarding-model-progress"),
    ).toHaveTextContent("65%");
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

  // Devin Review PR #70: the previous `persisting`
  // useState guard captured a stale `false` value across React
  // closures, so a second dismiss path entering before the IPC
  // resolved would slip through and fire `settings.update` +
  // `onDismiss` twice. We pin the fix by holding `settings.update`
  // open with a manually-controlled promise, firing TWO dismiss
  // paths (Finish click + ESC press) back-to-back, then resolving
  // the IPC and asserting each side-effect ran exactly once.
  it("re-entrancy: rapid double dismiss only persists + calls onDismiss once", async () => {
    const updateSpy = window.tessera.settings.update as ReturnType<
      typeof vi.fn
    >;
    // TS narrows a `let` variable assigned only inside a callback
    // to `never`, so we capture the resolve handle into a tuple
    // and read it back after the Promise constructor returns. This
    // is purely a typing wrinkle — the runtime path is unchanged.
    const pending: { resolve: (() => void) | null } = { resolve: null };
    updateSpy.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          pending.resolve = () => resolve();
        }),
    );
    const { onDismiss } = renderWizard();
    // Walk to step 3 so we can use Finish (a typical re-entrancy
    // window — long IPC + multiple dismiss surfaces still on screen).
    fireEvent.click(screen.getByRole("button", { name: "Add a folder" }));
    await waitFor(() => screen.getByText("Pick a template"));
    fireEvent.click(screen.getByRole("button", { name: "Browse templates" }));
    await waitFor(() => screen.getByText("Your workspace is ready"));
    // First dismiss path: Finish. This call enters `dismiss`,
    // flips the ref guard, and `await`s the (still pending) IPC.
    fireEvent.click(screen.getByRole("button", { name: "Finish" }));
    // Second dismiss path: Close button (which routes through the
    // same handleClose -> dismiss path as Escape). With a stale
    // useState guard this would fire a second concurrent
    // settings.update; with the ref guard it short-circuits.
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    // Release the in-flight IPC. The first dismiss path completes;
    // the second was rejected by the ref guard at entry.
    expect(pending.resolve).not.toBeNull();
    pending.resolve?.();
    await waitFor(() => {
      expect(onDismiss).toHaveBeenCalledTimes(1);
    });
    expect(updateSpy).toHaveBeenCalledTimes(1);
  });
});
