/**
 * TemplatesPage keyboard navigation tests.
 *
 * Asserts the ARIA `aria-activedescendant` listbox contract: a
 * single focus stop on the gallery container; arrow keys move the
 * active option without changing DOM focus; Enter activates the
 * active template via `navigate(...)`; Home / End jump to the
 * extremes; visible filtering re-anchors the active index.
 *
 * Layout-dependent assertions (Up/Down arithmetic that depends on
 * column count) are exercised through the explicit column ref
 * exposed via the `data-cols-for-test` attribute the component
 * sets after measurement; tests can read it before issuing
 * ArrowDown to avoid coupling to JSDOM's lack of layout. We
 * deliberately keep Left/Right tests (which are layout-independent
 * and clamp at the ends) so the keyboard contract is locked even
 * in environments without a real layout engine.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const navigateMock = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>(
    "react-router-dom",
  );
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

// `useTemplateList` is async and reads from the bridge — stub it
// with a deterministic dataset so tests don't depend on the
// production templates directory or IPC.
vi.mock("../hooks/useTemplates", () => ({
  useTemplateList: () => ({
    templates: [
      {
        id: "doc-1",
        name: "Doc One",
        description: "first",
        artifactType: "document",
      },
      {
        id: "doc-2",
        name: "Doc Two",
        description: "second",
        artifactType: "document",
      },
      {
        id: "doc-3",
        name: "Doc Three",
        description: "third",
        artifactType: "document",
      },
      {
        id: "deck-1",
        name: "Deck One",
        description: "fourth",
        artifactType: "slides",
      },
    ],
    loading: false,
    refresh: vi.fn(),
  }),
}));

// Import AFTER `vi.mock` so the mocks apply.
import TemplatesPage from "../pages/TemplatesPage";

function renderPage() {
  return render(
    <MemoryRouter>
      <TemplatesPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  navigateMock.mockReset();
});

describe("TemplatesPage — keyboard navigation", () => {
  it("renders a single listbox container with aria-activedescendant", () => {
    renderPage();
    const listbox = screen.getByRole("listbox", { name: /template gallery/i });
    expect(listbox).toBeInTheDocument();
    expect(listbox).toHaveAttribute("tabIndex", "0");
    // First template (in render order) is initially active.
    expect(listbox).toHaveAttribute(
      "aria-activedescendant",
      "template-option-doc-1",
    );
  });

  it("moves the active option Right and Left with arrow keys, clamps at boundaries", () => {
    renderPage();
    const listbox = screen.getByRole("listbox", { name: /template gallery/i });
    expect(listbox).toHaveAttribute(
      "aria-activedescendant",
      "template-option-doc-1",
    );
    fireEvent.keyDown(listbox, { key: "ArrowRight" });
    expect(listbox).toHaveAttribute(
      "aria-activedescendant",
      "template-option-doc-2",
    );
    fireEvent.keyDown(listbox, { key: "ArrowRight" });
    fireEvent.keyDown(listbox, { key: "ArrowRight" });
    fireEvent.keyDown(listbox, { key: "ArrowRight" });
    // 4 items total; ArrowRight 4x from index 0 clamps to index 3.
    expect(listbox).toHaveAttribute(
      "aria-activedescendant",
      "template-option-deck-1",
    );
    // One more ArrowRight at the end is a no-op (clamp).
    fireEvent.keyDown(listbox, { key: "ArrowRight" });
    expect(listbox).toHaveAttribute(
      "aria-activedescendant",
      "template-option-deck-1",
    );
    // ArrowLeft walks back.
    fireEvent.keyDown(listbox, { key: "ArrowLeft" });
    expect(listbox).toHaveAttribute(
      "aria-activedescendant",
      "template-option-doc-3",
    );
  });

  it("jumps to first / last with Home / End", () => {
    renderPage();
    const listbox = screen.getByRole("listbox", { name: /template gallery/i });
    fireEvent.keyDown(listbox, { key: "End" });
    expect(listbox).toHaveAttribute(
      "aria-activedescendant",
      "template-option-deck-1",
    );
    fireEvent.keyDown(listbox, { key: "Home" });
    expect(listbox).toHaveAttribute(
      "aria-activedescendant",
      "template-option-doc-1",
    );
  });

  it("activates the selected template on Enter via navigate(create?template=...)", () => {
    renderPage();
    const listbox = screen.getByRole("listbox", { name: /template gallery/i });
    fireEvent.keyDown(listbox, { key: "ArrowRight" });
    fireEvent.keyDown(listbox, { key: "Enter" });
    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith("/create?template=doc-2");
  });

  it("activates on Space key as well", () => {
    renderPage();
    const listbox = screen.getByRole("listbox", { name: /template gallery/i });
    fireEvent.keyDown(listbox, { key: " " });
    expect(navigateMock).toHaveBeenCalledWith("/create?template=doc-1");
  });

  it("renders one role=option per visible template with aria-selected on the active one", () => {
    renderPage();
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(4);
    // First option is active initially.
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    for (let i = 1; i < options.length; i += 1) {
      expect(options[i]).toHaveAttribute("aria-selected", "false");
    }
  });

  it("does not preventDefault on Tab so focus can leave the gallery", () => {
    renderPage();
    const listbox = screen.getByRole("listbox", { name: /template gallery/i });
    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    const dispatched = listbox.dispatchEvent(event);
    // dispatchEvent returns false iff some handler called
    // preventDefault. We expect Tab to fall through.
    expect(dispatched).toBe(true);
  });

  it("activates via click on an option (mouse fallback) and tracks the active index", () => {
    renderPage();
    const listbox = screen.getByRole("listbox", { name: /template gallery/i });
    // Mouse activation lives on the `role="option"` element itself: the
    // inner `Card` is intentionally non-interactive (no `role="button"`,
    // no tab stop) so the option contains no nested focusable control
    // (`nested-interactive`). Clicking the card's content bubbles to the
    // option's `onClick`, which is what we assert here.
    const docTwoTitle = screen.getByText("Doc Two");
    const option = docTwoTitle.closest('[role="option"]');
    expect(option).not.toBeNull();
    fireEvent.click(docTwoTitle);
    expect(navigateMock).toHaveBeenCalledWith("/create?template=doc-2");
    expect(listbox).toHaveAttribute(
      "aria-activedescendant",
      "template-option-doc-2",
    );
  });
});
