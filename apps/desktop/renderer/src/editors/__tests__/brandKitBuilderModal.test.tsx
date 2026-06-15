import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrandKitBuilderModal } from "../components/BrandKitBuilderModal";
import {
  BRAND_KITS_STORAGE_KEY,
  buildBrandKit,
  emptyBrandKitDraft,
  saveBrandKits,
  type BrandKit,
  type BrandKitDraft,
} from "../slideBrandKit";
import { __resetBrandKitsStoreForTests } from "../useBrandKits";

beforeEach(() => {
  window.localStorage.clear();
  __resetBrandKitsStoreForTests();
});

/** Render the modal open with stub host callbacks, returning the spies. */
function renderModal(overrides?: { activeKitId?: string }) {
  const onApply = vi.fn<[BrandKit], void>();
  const onClear = vi.fn();
  const onClose = vi.fn();
  const { unmount } = render(
    <BrandKitBuilderModal
      isOpen
      deckThemeId="aurora"
      activeKitId={overrides?.activeKitId}
      onApply={onApply}
      onClear={onClear}
      onClose={onClose}
    />,
  );
  return { onApply, onClear, onClose, unmount };
}

const HEX = /^#[0-9a-f]{6}$/;

describe("BrandKitBuilderModal", () => {
  it("seeds a live preview from the deck theme and re-skins it as colours change", async () => {
    const user = userEvent.setup();
    renderModal();

    const preview = screen.getByTestId("brand-kit-preview");
    // Seeded from the deck's base theme with coherent starting colours.
    expect(preview).toHaveAttribute("data-slide-theme", "aurora");
    expect(preview.style.getPropertyValue("--slide-accent")).toMatch(HEX);

    // Editing the accent hex re-skins the preview inline, live.
    const accent = screen.getByTestId("brand-kit-color-accent-hex");
    await user.clear(accent);
    await user.type(accent, "#0a0b0c");
    expect(preview.style.getPropertyValue("--slide-accent")).toBe("#0a0b0c");

    // A half-typed colour is simply skipped (no invalid value flashes).
    await user.clear(accent);
    await user.type(accent, "#0a0");
    // "#0a0" is valid shorthand and expands; assert it normalises.
    expect(preview.style.getPropertyValue("--slide-accent")).toBe("#00aa00");
  });

  it("maps a curated font choice onto the preview's font variable", async () => {
    const user = userEvent.setup();
    renderModal();

    await user.selectOptions(
      screen.getByTestId("brand-kit-heading-font"),
      "serif",
    );
    const preview = screen.getByTestId("brand-kit-preview");
    expect(preview.style.getPropertyValue("--slide-font-headline")).toContain(
      "Georgia",
    );
  });

  it("builds, persists and applies a valid kit, then closes", async () => {
    const user = userEvent.setup();
    const { onApply, onClose } = renderModal();

    await user.type(screen.getByTestId("brand-kit-name"), "Acme Corp");
    await user.selectOptions(
      screen.getByTestId("brand-kit-heading-font"),
      "serif",
    );
    await user.click(screen.getByTestId("brand-kit-save"));

    expect(onApply).toHaveBeenCalledTimes(1);
    const saved = onApply.mock.calls[0][0];
    expect(saved.name).toBe("Acme Corp");
    expect(saved.id.startsWith("brand-")).toBe(true);
    expect(saved.headingFont).toBe("serif");
    expect(saved.baseThemeId).toBe("aurora");
    expect(onClose).toHaveBeenCalledTimes(1);

    // Persisted to localStorage through the shared store.
    expect(window.localStorage.getItem(BRAND_KITS_STORAGE_KEY)).toContain(
      "Acme Corp",
    );
  });

  it("rejects an invalid draft: surfaces errors, does not apply or persist", async () => {
    const user = userEvent.setup();
    const { onApply } = renderModal();

    // The seeded draft has a blank name -> saving must fail validation.
    await user.click(screen.getByTestId("brand-kit-save"));

    expect(onApply).not.toHaveBeenCalled();
    const errors = screen.getByTestId("brand-kit-errors");
    expect(
      within(errors).getAllByTestId("brand-kit-error").length,
    ).toBeGreaterThan(0);
    expect(window.localStorage.getItem(BRAND_KITS_STORAGE_KEY)).toBeNull();
  });

  it("re-applies an already-saved kit from the saved list", async () => {
    const user = userEvent.setup();
    const { onApply, onClose } = renderModal();

    await user.type(screen.getByTestId("brand-kit-name"), "Acme Corp");
    await user.click(screen.getByTestId("brand-kit-save"));
    const id = onApply.mock.calls[0][0].id;

    // The saved kit now appears in the list; applying it re-invokes the host.
    await user.click(screen.getByTestId(`brand-kit-apply-${id}`));
    expect(onApply).toHaveBeenCalledTimes(2);
    expect(onApply.mock.calls[1][0].id).toBe(id);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("stops titling the modal an import once a saved kit is loaded", async () => {
    const user = userEvent.setup();

    // Seed a saved kit so the "Saved brand kits" list (and its
    // "Load into the editor" action) renders inside the modal.
    const seed = buildBrandKit(
      {
        ...emptyBrandKitDraft("aurora"),
        name: "Existing Kit",
        colors: {
          accent: "#0f766e",
          surface: "#f8fafc",
          text: "#0b1320",
          heading: "",
          muted: "",
        },
      },
      () => "brand-existing",
    );
    expect(seed.ok).toBe(true);
    if (!seed.ok) return;
    saveBrandKits([seed.brandKit]);
    __resetBrandKitsStoreForTests();

    // Open in import mode: the incoming draft carries no id.
    const importDraft: BrandKitDraft = {
      ...emptyBrandKitDraft("aurora"),
      name: "Imported Brand",
      colors: {
        accent: "#7c3aed",
        surface: "#ffffff",
        text: "#1e1b2e",
        heading: "",
        muted: "",
      },
    };
    render(
      <BrandKitBuilderModal
        isOpen
        deckThemeId="aurora"
        activeKitId={undefined}
        initialDraft={importDraft}
        onApply={vi.fn<[BrandKit], void>()}
        onClear={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    // It opens as an import…
    expect(screen.getByText("Import brand kit")).toBeInTheDocument();

    // …but loading a saved kit means we are now editing that kit, so the
    // title must track the live draft, not the immutable `initialDraft`.
    await user.click(
      within(screen.getByTestId("brand-kit-saved-brand-existing")).getByRole(
        "button",
        { name: /^Existing Kit$/ },
      ),
    );
    expect(screen.queryByText("Import brand kit")).not.toBeInTheDocument();
    expect(screen.getByText("Edit brand kit")).toBeInTheDocument();
  });

  it("deletes a saved kit and clears it from the deck when it was active", async () => {
    const user = userEvent.setup();
    // First create a kit so we know its id, then tear that modal down.
    const first = renderModal();
    await user.type(screen.getByTestId("brand-kit-name"), "Acme Corp");
    await user.click(screen.getByTestId("brand-kit-save"));
    const id = first.onApply.mock.calls[0][0].id;
    expect(window.localStorage.getItem(BRAND_KITS_STORAGE_KEY)).toContain(
      "Acme Corp",
    );
    first.unmount();

    // Re-open as if that kit is the deck's active brand kit, then delete it.
    const second = renderModal({ activeKitId: id });
    await user.click(screen.getByTestId(`brand-kit-delete-${id}`));

    expect(second.onClear).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(BRAND_KITS_STORAGE_KEY)).not.toContain(
      "Acme Corp",
    );
  });
});
