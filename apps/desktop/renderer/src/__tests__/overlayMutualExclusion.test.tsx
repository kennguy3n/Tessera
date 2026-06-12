/**
 * The command palette (Cmd+K / Cmd+P) and the quick switcher (Cmd+O)
 * are mutually exclusive full-screen overlays at the same z-index.
 * Opening either one must close the other so they can never stack into
 * a broken interaction state (Devin Review PR #146). This guards the
 * symmetry of the `tessera:open-palette` / `tessera:open-quick-switch`
 * handlers in `App`.
 */

import { act } from "react";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import App from "../App";

function renderApp() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <App />
    </MemoryRouter>,
  );
}

function dispatch(event: string, detail?: unknown) {
  act(() => {
    window.dispatchEvent(
      detail === undefined
        ? new Event(event)
        : new CustomEvent(event, { detail }),
    );
  });
}

afterEach(cleanup);

describe("palette / quick-switcher mutual exclusion", () => {
  it("opening the palette closes an open quick switcher", async () => {
    renderApp();

    dispatch("tessera:open-quick-switch");
    await waitFor(() =>
      expect(screen.getByTestId("quick-switcher-overlay")).toBeInTheDocument(),
    );

    dispatch("tessera:open-palette");
    await waitFor(() =>
      expect(screen.getByTestId("command-palette-overlay")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("quick-switcher-overlay")).not.toBeInTheDocument();
  });

  it("opening the quick switcher closes an open palette", async () => {
    renderApp();

    dispatch("tessera:open-palette");
    await waitFor(() =>
      expect(screen.getByTestId("command-palette-overlay")).toBeInTheDocument(),
    );

    dispatch("tessera:open-quick-switch");
    await waitFor(() =>
      expect(screen.getByTestId("quick-switcher-overlay")).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId("command-palette-overlay"),
    ).not.toBeInTheDocument();
  });
});
