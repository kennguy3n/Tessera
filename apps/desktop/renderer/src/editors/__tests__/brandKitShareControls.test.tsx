import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrandKitShareControls } from "../components/BrandKitShareControls";
import { BrandKitBuilderModal } from "../components/BrandKitBuilderModal";
import { __resetBrandKitsStoreForTests } from "../useBrandKits";
import {
  BRAND_KIT_ID_PREFIX,
  buildBrandKit,
  emptyBrandKitDraft,
  serializeBrandPack,
  type BrandKit,
  type BrandKitDraft,
} from "../slideBrandKit";

// jsdom (the renderer test env) does NOT ship URL.createObjectURL /
// revokeObjectURL. The Export codepath relies on them, so install minimal
// implementations once at module load so `vi.spyOn` can stub them.
if (typeof URL.createObjectURL === "undefined") {
  Object.defineProperty(URL, "createObjectURL", {
    value: (_blob: Blob) => "blob:test",
    configurable: true,
    writable: true,
  });
}
if (typeof URL.revokeObjectURL === "undefined") {
  Object.defineProperty(URL, "revokeObjectURL", {
    value: (_url: string) => {},
    configurable: true,
    writable: true,
  });
}

// jsdom's Blob/File does not implement the async `.text()` reader the Import
// codepath uses (the production app runs on Chromium 126, which does). Back it
// with jsdom's supported `FileReader` so File.text() resolves in tests.
if (typeof Blob.prototype.text !== "function") {
  Object.defineProperty(Blob.prototype, "text", {
    value(this: Blob): Promise<string> {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(this);
      });
    },
    configurable: true,
    writable: true,
  });
}

const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

beforeEach(() => {
  window.localStorage.clear();
  __resetBrandKitsStoreForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Build a kit with a deterministic id so assertions are stable. */
function buildKit(id = "source"): BrandKit {
  const result = buildBrandKit(
    {
      ...emptyBrandKitDraft("aurora"),
      name: "Globex Industries",
      colors: {
        accent: "#0f766e",
        surface: "#f8fafc",
        text: "#0b1320",
        heading: "",
        muted: "",
      },
      logoDataUrl: PNG_DATA_URL,
      logoAlt: "Globex mark",
      logoPlacement: "br",
    },
    () => `${BRAND_KIT_ID_PREFIX}${id}`,
  );
  if (!result.ok)
    throw new Error(`unexpected build failure: ${result.errors.join(", ")}`);
  return result.brandKit;
}

/**
 * A host wiring the share controls to the builder modal exactly as the Slide
 * editor does: an import seeds `initialDraft` and opens the modal; saving runs
 * through the real build → persist path and reports the applied kit's id.
 */
function Host({ activeKit = null }: { activeKit?: BrandKit | null }) {
  const [open, setOpen] = useState(false);
  const [importDraft, setImportDraft] = useState<BrandKitDraft | null>(null);
  const [appliedId, setAppliedId] = useState("");
  return (
    <>
      <span data-testid="applied">{appliedId}</span>
      <BrandKitShareControls
        activeKit={activeKit}
        onImported={(draft) => {
          setImportDraft(draft);
          setOpen(true);
        }}
      />
      {open && (
        <BrandKitBuilderModal
          isOpen
          deckThemeId="aurora"
          activeKitId={undefined}
          initialDraft={importDraft ?? undefined}
          onApply={(kit) => setAppliedId(kit.id)}
          onClear={() => {}}
          onClose={() => {
            setOpen(false);
            setImportDraft(null);
          }}
        />
      )}
    </>
  );
}

describe("BrandKitShareControls", () => {
  it("disables Export without an active kit but always allows Import", () => {
    render(<Host activeKit={null} />);
    expect(screen.getByTestId("brand-share-export")).toBeDisabled();
    expect(screen.getByTestId("brand-share-import")).toBeEnabled();
  });

  it("exports the active kit via the browser download dance", () => {
    const createSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:mock");
    const revokeSpy = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    const realCreate = document.createElement.bind(document);
    let lastAnchor: HTMLAnchorElement | null = null;
    const createElSpy = vi
      .spyOn(document, "createElement")
      .mockImplementation((tag: string) => {
        const el = realCreate(tag);
        if (tag === "a") {
          lastAnchor = el as HTMLAnchorElement;
          (el as HTMLAnchorElement).click = vi.fn();
        }
        return el;
      });

    render(<Host activeKit={buildKit()} />);
    fireEvent.click(screen.getByTestId("brand-share-export"));

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy.mock.calls[0][0]).toBeInstanceOf(Blob);
    expect(revokeSpy).toHaveBeenCalledTimes(1);
    expect(lastAnchor).not.toBeNull();
    expect(lastAnchor!.download).toBe("tessera-brand-globex-industries.json");
    expect(lastAnchor!.click as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(
      1,
    );

    createElSpy.mockRestore();
  });

  it("imports a brand pack file and opens the builder pre-filled", async () => {
    render(<Host activeKit={null} />);

    const source = buildKit();
    const file = new File([serializeBrandPack(source)], "shared.json", {
      type: "application/json",
    });
    fireEvent.change(screen.getByTestId("brand-share-import-input"), {
      target: { files: [file] },
    });

    // Builder opens pre-filled (like Duplicate) under the import title.
    await screen.findByTestId("brand-kit-builder");
    expect(screen.getByText("Import brand kit")).toBeInTheDocument();
    const name = screen.getByTestId("brand-kit-name") as HTMLInputElement;
    expect(name.value).toBe("Globex Industries");
    expect(
      screen.queryByTestId("brand-share-import-error"),
    ).not.toBeInTheDocument();
  });

  it("saving an imported pack mints a NEW kit id (never overwrites)", async () => {
    const user = userEvent.setup();
    render(<Host activeKit={null} />);

    const source = buildKit("source");
    const file = new File([serializeBrandPack(source)], "shared.json", {
      type: "application/json",
    });
    fireEvent.change(screen.getByTestId("brand-share-import-input"), {
      target: { files: [file] },
    });
    await screen.findByTestId("brand-kit-builder");
    await user.click(screen.getByTestId("brand-kit-save"));

    const applied = screen.getByTestId("applied").textContent ?? "";
    expect(applied.startsWith(BRAND_KIT_ID_PREFIX)).toBe(true);
    expect(applied).not.toBe(source.id);
    // The modal closed after a successful save.
    expect(screen.queryByTestId("brand-kit-builder")).not.toBeInTheDocument();
  });

  it("shows an inline error for a bad file and opens no builder", async () => {
    render(<Host activeKit={null} />);

    const file = new File(["not json{"], "bad.json", {
      type: "application/json",
    });
    fireEvent.change(screen.getByTestId("brand-share-import-input"), {
      target: { files: [file] },
    });

    const error = await screen.findByTestId("brand-share-import-error");
    expect(error).toHaveAttribute("role", "alert");
    expect(error.textContent).toMatch(/JSON/i);
    expect(screen.queryByTestId("brand-kit-builder")).not.toBeInTheDocument();
  });
});
