/**
 * Accessibility regression suite — pins WAI-ARIA + WCAG patterns
 * across the components most likely to drift:
 *
 *   * Modal: focus trap (Tab cycles inside, Shift+Tab from first
 *     wraps to last), Escape closes, role="dialog",
 *     aria-modal="true", aria-labelledby points to the title.
 *   * SlideEditor: active slide thumbnail has aria-current="true";
 *     Speaker Notes textarea has a programmatically associated
 *     label via htmlFor / matching id.
 *   * SettingsPage labels: every form control (Theme, Watch
 *     Patterns, Ignore Patterns, Default Export Format) has a
 *     <label> whose htmlFor matches the control's id.
 *   * Sidebar: NavLink renders aria-current="page" on the active
 *     route (react-router-dom contract — pinned here so a future
 *     refactor that swaps NavLink for <a> is caught immediately).
 *
 * These tests would be easy to write off as "the framework already
 * does it" — but every single pattern here has been broken at least
 * once in a real-world React codebase by a refactor that dropped a
 * line. The suite serves as a contract between today's accessible
 * UI and tomorrow's maintainer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import Modal from "../components/Modal";
import SlideEditor from "../editors/SlideEditor";
import Sidebar from "../components/Sidebar";

// ---------------------------------------------------------------------------
// Modal accessibility
// ---------------------------------------------------------------------------

describe("Modal accessibility", () => {
  function renderModal(props: Partial<React.ComponentProps<typeof Modal>> = {}) {
    const onClose = props.onClose ?? vi.fn();
    return {
      onClose,
      ...render(
        <Modal isOpen={true} onClose={onClose} title="Test Dialog" {...props}>
          <button type="button">First</button>
          <input type="text" defaultValue="middle" />
          <button type="button">Last</button>
        </Modal>,
      ),
    };
  }

  it("declares role=dialog, aria-modal=true, and aria-labelledby pointing at the title", () => {
    renderModal();
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const titleId = dialog.getAttribute("aria-labelledby");
    expect(titleId).toBeTruthy();
    const title = document.getElementById(titleId!);
    expect(title).not.toBeNull();
    expect(title!.textContent).toBe("Test Dialog");
  });

  it("auto-focuses the first focusable child on open (deferred via setTimeout)", () => {
    vi.useFakeTimers();
    try {
      renderModal();
      // Modal defers focus via setTimeout(0) so React's commit phase
      // can finish.
      act(() => {
        vi.runAllTimers();
      });
      const first = screen.getByRole("button", { name: "First" });
      expect(document.activeElement).toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes on Escape", () => {
    const { onClose } = renderModal();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Tab from the last focusable wraps to the first (focus trap forward)", () => {
    vi.useFakeTimers();
    try {
      renderModal();
      act(() => {
        vi.runAllTimers();
      });
      const last = screen.getByRole("button", { name: "Last" });
      last.focus();
      expect(document.activeElement).toBe(last);
      fireEvent.keyDown(document, { key: "Tab" });
      const first = screen.getByRole("button", { name: "First" });
      expect(document.activeElement).toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Shift+Tab from the first focusable wraps to the last (focus trap reverse)", () => {
    vi.useFakeTimers();
    try {
      renderModal();
      act(() => {
        vi.runAllTimers();
      });
      const first = screen.getByRole("button", { name: "First" });
      first.focus();
      fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
      const last = screen.getByRole("button", { name: "Last" });
      expect(document.activeElement).toBe(last);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// SlideEditor accessibility
// ---------------------------------------------------------------------------

describe("SlideEditor accessibility", () => {
  it("marks the active slide thumbnail with aria-current=true and others without it", () => {
    const slides = {
      slides: [
        { title: "First", blocks: [{ type: "text", content: "a" }], notes: "" },
        { title: "Second", blocks: [{ type: "text", content: "b" }], notes: "" },
        { title: "Third", blocks: [{ type: "text", content: "c" }], notes: "" },
      ],
    };
    render(<SlideEditor content={JSON.stringify(slides)} onSave={vi.fn()} />);
    const firstThumb = screen.getByRole("button", { name: /1 First/ });
    const secondThumb = screen.getByRole("button", { name: /2 Second/ });
    const thirdThumb = screen.getByRole("button", { name: /3 Third/ });
    expect(firstThumb.getAttribute("aria-current")).toBe("true");
    expect(secondThumb.getAttribute("aria-current")).toBeNull();
    expect(thirdThumb.getAttribute("aria-current")).toBeNull();

    // Click the second thumbnail — aria-current must move with the
    // active state.
    fireEvent.click(secondThumb);
    expect(firstThumb.getAttribute("aria-current")).toBeNull();
    expect(secondThumb.getAttribute("aria-current")).toBe("true");
  });

  it("wires the Speaker Notes textarea to its label via htmlFor and matching id", () => {
    const slides = {
      slides: [
        {
          title: "Slide 1",
          blocks: [{ type: "text", content: "body" }],
          notes: "Existing notes",
        },
      ],
    };
    render(<SlideEditor content={JSON.stringify(slides)} onSave={vi.fn()} />);
    // Speaker notes are hidden until the user toggles "Show Notes".
    const toggle = screen.getByRole("button", { name: /Notes/ });
    fireEvent.click(toggle);
    // The textarea is now accessible by its label text.
    const notes = screen.getByLabelText("Speaker Notes");
    expect(notes).toBeInstanceOf(HTMLTextAreaElement);
    expect((notes as HTMLTextAreaElement).value).toBe("Existing notes");
  });
});

// ---------------------------------------------------------------------------
// SettingsPage label↔input wiring
// ---------------------------------------------------------------------------

// We render SettingsPage indirectly via a thin harness because the
// real page pulls in IPC-backed `useSettings`. We mock the hook so
// the suite focuses on the DOM contract.
vi.mock("../hooks/useSettings", () => ({
  useSettings: () => ({
    settings: {
      theme: "system",
      defaultExportFormat: "markdown",
      ignorePatterns: [".git", "node_modules"],
      watchPatterns: ["**/*.md"],
      onboardingCompleted: true,
    },
    loading: false,
    refresh: vi.fn(),
  }),
  useUpdateSetting: () => ({ update: vi.fn().mockResolvedValue(undefined) }),
}));

// ModelRuntimeCard, ExternalProviderCard, HybridSearchCard each pull
// in their own IPC bridges. Stub them so the page renders.
vi.mock("../components/ModelRuntimeCard", () => ({
  default: () => null,
}));
vi.mock("../components/ExternalProviderCard", () => ({
  default: () => null,
}));
vi.mock("../components/HybridSearchCard", () => ({
  default: () => null,
}));

describe("SettingsPage label associations", () => {
  beforeEach(() => {
    // Ensure each test sees a fresh DOM — useId mints stable ids
    // per render tree, not per file.
  });
  afterEach(() => {
    // No-op; render() teardown is handled by testing-library.
  });

  it("wires every sibling-pattern label to its input via htmlFor/id", async () => {
    const { default: SettingsPage } = await import("../pages/SettingsPage");
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );

    // getByLabelText fails if no <label htmlFor=> matches an input
    // with that id (or wraps it). This is the single best assertion
    // for the contract.
    expect(screen.getByLabelText("Theme")).toBeInstanceOf(HTMLSelectElement);
    expect(screen.getByLabelText("Watch Patterns")).toBeInstanceOf(
      HTMLInputElement,
    );
    expect(screen.getByLabelText("Ignore Patterns")).toBeInstanceOf(
      HTMLInputElement,
    );
    expect(screen.getByLabelText("Default Export Format")).toBeInstanceOf(
      HTMLSelectElement,
    );
  });
});

// ---------------------------------------------------------------------------
// Sidebar — aria-current="page" on the active route
// ---------------------------------------------------------------------------

describe("Sidebar accessibility", () => {
  it("renders aria-current=page on the NavLink that matches the URL", () => {
    render(
      <MemoryRouter initialEntries={["/sources"]}>
        <Sidebar />
      </MemoryRouter>,
    );
    const nav = screen.getByRole("navigation", { name: "Main navigation" });
    const sourcesLink = within(nav).getByRole("link", { name: /Sources/ });
    expect(sourcesLink.getAttribute("aria-current")).toBe("page");
    // Other links should NOT be marked aria-current.
    const tasksLink = within(nav).getByRole("link", { name: /Tasks/ });
    expect(tasksLink.getAttribute("aria-current")).toBeNull();
  });
});
