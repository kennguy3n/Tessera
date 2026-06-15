import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseBaseDocument } from "../baseDocumentHelpers";
import type { BaseDocument } from "../baseEditorTypes";

/**
 * A single built-in template whose `build` is a spy, so we can assert it
 * runs exactly once across the "Use" → "Replace" confirm flow (the deferred
 * build fix) rather than once on preview and again on confirm. The spy is
 * declared via `vi.hoisted` so the hoisted `vi.mock` factory can close over
 * it; its implementation is wired up in `beforeEach` once imports resolve.
 */
const { buildSpy } = vi.hoisted(() => ({
  buildSpy: vi.fn<[], BaseDocument>(),
}));

vi.mock("../baseTemplates", () => ({
  BASE_TEMPLATE_CATEGORIES: ["CRM"],
  BASE_TEMPLATES: [
    {
      id: "crm",
      label: "CRM",
      description: "Track accounts and deals.",
      category: "CRM",
      build: buildSpy,
    },
  ],
}));

import { BaseTemplateGallery } from "../components/BaseTemplateGallery";
import { __resetCustomBaseTemplatesStoreForTests } from "../useCustomBaseTemplates";

function docWith(
  records: ReadonlyArray<Record<string, unknown>>,
): BaseDocument {
  return parseBaseDocument(
    JSON.stringify({ fields: [{ name: "Name", type: "text" }], records }),
  );
}

beforeEach(() => {
  window.localStorage.clear();
  __resetCustomBaseTemplatesStoreForTests();
  buildSpy.mockReset();
  buildSpy.mockImplementation(() => docWith([]));
});

describe("BaseTemplateGallery built-in apply flow", () => {
  it("applies immediately on an empty base, building the template once", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    const onClose = vi.fn();
    render(
      <BaseTemplateGallery
        isOpen
        currentDoc={docWith([])}
        onApply={onApply}
        onClose={onClose}
      />,
    );

    await user.click(screen.getByTestId("base-template-use-builtin"));

    expect(buildSpy).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    const applied = onApply.mock.calls[0][0] as BaseDocument;
    expect(applied.tables).toHaveLength(1);
  });

  it("defers the build behind the replace guard and builds exactly once on confirm", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    const onClose = vi.fn();
    render(
      <BaseTemplateGallery
        isOpen
        currentDoc={docWith([{ id: "r1", Name: "Acme" }])}
        onApply={onApply}
        onClose={onClose}
      />,
    );

    // Requesting apply on a non-empty base must NOT build or apply yet — it
    // only surfaces the inline confirm.
    await user.click(screen.getByTestId("base-template-use-builtin"));
    expect(buildSpy).not.toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();
    expect(
      screen.getByTestId("base-template-confirm-apply"),
    ).toBeInTheDocument();

    await user.click(screen.getByTestId("base-template-confirm-apply"));
    expect(buildSpy).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("never builds or applies when the replace confirm is cancelled", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    const onClose = vi.fn();
    render(
      <BaseTemplateGallery
        isOpen
        currentDoc={docWith([{ id: "r1", Name: "Acme" }])}
        onApply={onApply}
        onClose={onClose}
      />,
    );

    await user.click(screen.getByTestId("base-template-use-builtin"));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(buildSpy).not.toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    // The "Use" affordance returns so the gallery stays usable.
    expect(screen.getByTestId("base-template-use-builtin")).toBeInTheDocument();
  });
});
