/**
 * Wiring tests for the App-level command side effects: the
 * create-artifact and substrate decay/synthesis events must call the
 * live bridge, navigate, and toast — and degrade gracefully when the
 * bridge is missing or the type is unknown.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import { ToastContext } from "../../components/toastContext";
import { useGlobalCommandActions } from "../useGlobalCommandActions";

const navigateMock = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>(
    "react-router-dom",
  );
  return { ...actual, useNavigate: () => navigateMock };
});

const addToast = vi.fn();

type TesseraWindow = typeof window & { tessera?: Record<string, unknown> };
const savedTessera = (window as TesseraWindow).tessera;

/** Assign `window.tessera` past its non-optional global type for tests. */
function setTessera(value: unknown): void {
  (window as unknown as { tessera?: unknown }).tessera = value;
}

function bridge() {
  return (window as TesseraWindow).tessera as unknown as {
    artifacts: { create: ReturnType<typeof vi.fn> };
    substrate: {
      runDecaySweep: ReturnType<typeof vi.fn>;
      triggerSynthesis: ReturnType<typeof vi.fn>;
    };
  };
}

function Harness(): ReactNode {
  useGlobalCommandActions();
  return null;
}

function mount() {
  render(
    <MemoryRouter>
      <ToastContext.Provider value={{ addToast, dismissToast: vi.fn() }}>
        <Harness />
      </ToastContext.Provider>
    </MemoryRouter>,
  );
}

function fire(type: string, detail?: unknown) {
  window.dispatchEvent(
    new CustomEvent(type, detail ? { detail } : undefined),
  );
}

beforeEach(() => {
  navigateMock.mockReset();
  addToast.mockReset();
  // Clear call history on the shared bridge mocks (without dropping
  // their implementations) so one test's create/substrate calls don't
  // leak into the next's "not called" assertions.
  vi.clearAllMocks();
});

afterEach(() => {
  // Restore only the bridge reference — the shared setup mocks are
  // created once at module load, so restoring/resetting all mocks here
  // would strip their implementations for later tests in the suite.
  setTessera(savedTessera);
});

describe("useGlobalCommandActions", () => {
  it("creates an artifact of the requested type and opens its editor", async () => {
    mount();
    fire("tessera:create-artifact", { type: "slides" });
    await waitFor(() =>
      expect(bridge().artifacts.create).toHaveBeenCalledWith(
        "Untitled deck",
        "slides",
      ),
    );
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith("/artifacts/art-1/edit"),
    );
  });

  it("ignores an unknown artifact type", () => {
    mount();
    fire("tessera:create-artifact", { type: "not-a-type" });
    expect(bridge().artifacts.create).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("runs the decay sweep and toasts the report counts", async () => {
    bridge().substrate.runDecaySweep.mockResolvedValueOnce({
      scored: 12,
      candidatesArchived: 3,
      supersededArchived: 1,
    });
    mount();
    fire("tessera:run-decay-sweep");
    await waitFor(() => expect(bridge().substrate.runDecaySweep).toHaveBeenCalled());
    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith(
        expect.stringContaining("12 scored, 4 archived"),
        "success",
      ),
    );
  });

  it("triggers synthesis and toasts the recap", async () => {
    bridge().substrate.triggerSynthesis.mockResolvedValueOnce({
      windowId: "w",
      scopeId: "s",
      version: 2,
      recap: "All quiet",
      decisions: [],
      openQuestions: [],
    });
    mount();
    fire("tessera:trigger-synthesis");
    await waitFor(() =>
      expect(bridge().substrate.triggerSynthesis).toHaveBeenCalled(),
    );
    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith(
        expect.stringContaining("All quiet"),
        "success",
      ),
    );
  });

  it("opens the system print dialog on tessera:print", () => {
    const printSpy = vi
      .spyOn(window, "print")
      .mockImplementation(() => undefined);
    try {
      mount();
      fire("tessera:print");
      expect(printSpy).toHaveBeenCalledTimes(1);
    } finally {
      printSpy.mockRestore();
    }
  });

  it("toasts an error instead of throwing when the bridge is absent", () => {
    setTessera(undefined);
    mount();
    fire("tessera:create-artifact", { type: "document" });
    expect(addToast).toHaveBeenCalledWith(
      expect.stringContaining("desktop bridge"),
      "error",
    );
  });
});
