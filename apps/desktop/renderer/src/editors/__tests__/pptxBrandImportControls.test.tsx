import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { BrandKitShareControls } from "../components/BrandKitShareControls";
import { BrandKitBuilderModal } from "../components/BrandKitBuilderModal";
import { __resetBrandKitsStoreForTests } from "../useBrandKits";
import { BRAND_KIT_ID_PREFIX, type BrandKitDraft } from "../slideBrandKit";

// jsdom does not implement Blob/File.arrayBuffer (Chromium 126 does), which
// the `.pptx` import path uses. Back it with the supported FileReader, the
// same shape as the `.text()` polyfill in brandKitShareControls.test.tsx.
if (typeof Blob.prototype.arrayBuffer !== "function") {
  Object.defineProperty(Blob.prototype, "arrayBuffer", {
    value(this: Blob): Promise<ArrayBuffer> {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(this);
      });
    },
    configurable: true,
    writable: true,
  });
}

const THEME_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Test">` +
  `<a:themeElements><a:clrScheme name="Test">` +
  `<a:dk1><a:srgbClr val="1E1B2E"/></a:dk1>` +
  `<a:lt1><a:srgbClr val="FAF8FF"/></a:lt1>` +
  `<a:accent1><a:srgbClr val="7C3AED"/></a:accent1>` +
  `</a:clrScheme>` +
  `<a:fontScheme name="Test">` +
  `<a:majorFont><a:latin typeface="Cambria"/></a:majorFont>` +
  `<a:minorFont><a:latin typeface="Calibri"/></a:minorFont>` +
  `</a:fontScheme></a:themeElements></a:theme>`;

function pptxFile(name: string): File {
  const bytes = zipSync({
    "[Content_Types].xml": strToU8("<Types/>"),
    "ppt/theme/theme1.xml": strToU8(THEME_XML),
  });
  return new File([bytes], name, {
    type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  });
}

/** Host wiring the share controls to the builder exactly as the Slide editor does. */
function Host() {
  const [open, setOpen] = useState(false);
  const [importDraft, setImportDraft] = useState<BrandKitDraft | null>(null);
  const [appliedId, setAppliedId] = useState("");
  return (
    <>
      <span data-testid="applied">{appliedId}</span>
      <BrandKitShareControls
        activeKit={null}
        deckThemeId="aurora"
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

beforeEach(() => {
  window.localStorage.clear();
  __resetBrandKitsStoreForTests();
});

describe("BrandKitShareControls — .pptx import", () => {
  it("offers a dedicated .pptx import control", () => {
    render(<Host />);
    expect(screen.getByTestId("brand-share-import-pptx")).toBeEnabled();
  });

  it("imports a .pptx and opens the builder pre-filled", async () => {
    render(<Host />);

    fireEvent.change(screen.getByTestId("brand-share-import-pptx-input"), {
      target: { files: [pptxFile("Acme Brand.pptx")] },
    });

    await screen.findByTestId("brand-kit-builder");
    expect(screen.getByText("Import brand kit")).toBeInTheDocument();
    const name = screen.getByTestId("brand-kit-name") as HTMLInputElement;
    expect(name.value).toBe("Acme Brand");
    expect(
      screen.queryByTestId("brand-share-import-error"),
    ).not.toBeInTheDocument();
  });

  it("saving a .pptx-imported draft mints a NEW kit id", async () => {
    const user = userEvent.setup();
    render(<Host />);

    fireEvent.change(screen.getByTestId("brand-share-import-pptx-input"), {
      target: { files: [pptxFile("Acme Brand.pptx")] },
    });
    await screen.findByTestId("brand-kit-builder");
    await user.click(screen.getByTestId("brand-kit-save"));

    const applied = screen.getByTestId("applied").textContent ?? "";
    expect(applied.startsWith(BRAND_KIT_ID_PREFIX)).toBe(true);
    expect(screen.queryByTestId("brand-kit-builder")).not.toBeInTheDocument();
  });

  it("shows an inline error for a non-.pptx file and opens no builder", async () => {
    render(<Host />);

    const bad = new File([new Uint8Array([1, 2, 3, 4, 5])], "notes.pptx", {
      type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });
    fireEvent.change(screen.getByTestId("brand-share-import-pptx-input"), {
      target: { files: [bad] },
    });

    const error = await screen.findByTestId("brand-share-import-error");
    expect(error).toHaveAttribute("role", "alert");
    expect(screen.queryByTestId("brand-kit-builder")).not.toBeInTheDocument();
  });
});
