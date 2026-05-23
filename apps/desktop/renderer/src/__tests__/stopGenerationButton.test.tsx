import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import "@testing-library/jest-dom";

import StopGenerationButton from "../components/StopGenerationButton";
import {
  notifyGenerationStarted,
  _resetActiveGenerationForTests,
} from "../hooks/useActiveGeneration";
import type { GenerateChunk } from "../types/ipc";

/** Capture the token-handler the hook registers with the IPC layer
 *  so tests can synthesize `done: false` / `done: true` events
 *  without spinning up an IPC channel. */
let tokenHandler: ((chunk: GenerateChunk) => void) | null = null;
let cancelMock = vi.fn();

beforeEach(() => {
  _resetActiveGenerationForTests();
  tokenHandler = null;
  cancelMock = vi.fn().mockResolvedValue(undefined);
  // Replace the model surface only \u2014 leave the rest of the
  // global `window.tessera` mock from `src/__tests__/setup.ts`
  // intact.
  const originalModel = window.tessera.model;
  Object.defineProperty(window.tessera, "model", {
    configurable: true,
    value: {
      ...originalModel,
      cancelJob: cancelMock,
      onToken: (cb: (chunk: GenerateChunk) => void) => {
        tokenHandler = cb;
        return () => {
          tokenHandler = null;
        };
      },
    },
  });
});

describe("StopGenerationButton", () => {
  it("renders nothing while no generation is active", () => {
    render(<StopGenerationButton />);
    expect(
      screen.queryByTestId("stop-generation-button"),
    ).not.toBeInTheDocument();
  });

  it("renders the button when a non-done token is received", () => {
    render(<StopGenerationButton />);
    expect(tokenHandler).not.toBeNull();
    act(() => {
      tokenHandler!({ token: "hello ", done: false });
    });
    const button = screen.getByTestId("stop-generation-button");
    expect(button).toBeInTheDocument();
    expect(button).toHaveAccessibleName("Stop generating");
  });

  it("renders the button when notifyGenerationStarted is called even before tokens arrive", () => {
    render(<StopGenerationButton />);
    act(() => {
      notifyGenerationStarted();
    });
    expect(
      screen.getByTestId("stop-generation-button"),
    ).toBeInTheDocument();
  });

  it("removes the button when a done:true token arrives", () => {
    render(<StopGenerationButton />);
    act(() => {
      tokenHandler!({ token: "hi", done: false });
    });
    expect(screen.getByTestId("stop-generation-button")).toBeInTheDocument();
    act(() => {
      tokenHandler!({ token: "", done: true });
    });
    expect(
      screen.queryByTestId("stop-generation-button"),
    ).not.toBeInTheDocument();
  });

  it("invokes model:cancelJob and immediately hides on click", async () => {
    render(<StopGenerationButton />);
    act(() => {
      tokenHandler!({ token: "hi", done: false });
    });
    const button = screen.getByTestId("stop-generation-button");

    await act(async () => {
      button.click();
      // Allow the awaited cancelJob() resolution to settle so the
      // post-cancel state flip happens within the act() boundary.
      await Promise.resolve();
    });

    expect(cancelMock).toHaveBeenCalledTimes(1);
    // The button hides optimistically after click \u2014 even before
    // the eventual `done: true` arrives.
    expect(
      screen.queryByTestId("stop-generation-button"),
    ).not.toBeInTheDocument();
  });

  it("survives a transient cancelJob rejection without leaving the button stuck on", async () => {
    cancelMock.mockRejectedValueOnce(new Error("ipc closed"));
    render(<StopGenerationButton />);
    act(() => {
      tokenHandler!({ token: "hi", done: false });
    });
    const button = screen.getByTestId("stop-generation-button");
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
    // Even though cancelJob threw, the local optimistic flip still
    // hides the button so the user is not stuck with a control
    // that no longer matches intent.
    expect(
      screen.queryByTestId("stop-generation-button"),
    ).not.toBeInTheDocument();
  });
});
