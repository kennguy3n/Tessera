import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentTemplateGallery } from "../components/DocumentTemplateGallery";
import { __resetCustomDocumentTemplatesStoreForTests } from "../useCustomDocumentTemplates";
import {
  buildCustomDocumentTemplate,
  saveCustomDocumentTemplates,
  serializeDocumentTemplate,
  DOCUMENT_TEMPLATE_FORMAT,
  type CustomDocumentTemplate,
  type CustomDocumentTemplateDraft,
} from "../customDocumentTemplates";

// jsdom ships neither URL.createObjectURL/revokeObjectURL (Export) nor an
// async Blob.text() (Import). Production runs on Chromium, which has both;
// back them minimally so the export/import codepaths run in tests.
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

const SAMPLE_HTML = "<h1>My doc</h1><p>Body.</p>";

function customTemplate(
  overrides: Partial<CustomDocumentTemplateDraft> = {},
): CustomDocumentTemplate {
  const result = buildCustomDocumentTemplate({
    label: "Saved doc",
    description: "A saved one",
    category: "Meetings",
    content: SAMPLE_HTML,
    ...overrides,
  });
  if (!result.ok) throw new Error("fixture build failed");
  return result.template;
}

/** Seed the persisted store, then reset the in-memory store so the next
 * mount lazy-loads the seeded list from localStorage. */
function seed(templates: CustomDocumentTemplate[]): void {
  saveCustomDocumentTemplates(templates);
  __resetCustomDocumentTemplatesStoreForTests();
}

type Handlers = {
  onClose: () => void;
  onApply: (content: string) => void;
  onSaveCurrent: () => void;
  onEditTemplate: (t: CustomDocumentTemplate) => void;
  onImportDraft: (d: CustomDocumentTemplateDraft) => void;
};

function renderGallery(overrides: Partial<Handlers> = {}) {
  const handlers: Handlers = {
    onClose: vi.fn(),
    onApply: vi.fn(),
    onSaveCurrent: vi.fn(),
    onEditTemplate: vi.fn(),
    onImportDraft: vi.fn(),
    ...overrides,
  };
  render(
    <DocumentTemplateGallery
      isOpen
      onApply={handlers.onApply}
      onClose={handlers.onClose}
      onSaveCurrent={handlers.onSaveCurrent}
      onEditTemplate={handlers.onEditTemplate}
      onImportDraft={handlers.onImportDraft}
    />,
  );
  return handlers;
}

beforeEach(() => {
  window.localStorage.clear();
  __resetCustomDocumentTemplatesStoreForTests();
});

describe("DocumentTemplateGallery", () => {
  it("renders built-in template cards", () => {
    renderGallery();
    expect(
      screen.getByTestId("document-template-insert-doc-meeting-notes"),
    ).toBeTruthy();
    expect(screen.getByText("Document templates")).toBeTruthy();
  });

  it("does not render when closed", () => {
    const handlers: Handlers = {
      onClose: vi.fn(),
      onApply: vi.fn(),
      onSaveCurrent: vi.fn(),
      onEditTemplate: vi.fn(),
      onImportDraft: vi.fn(),
    };
    const { container } = render(
      <DocumentTemplateGallery
        isOpen={false}
        onApply={handlers.onApply}
        onClose={handlers.onClose}
        onSaveCurrent={handlers.onSaveCurrent}
        onEditTemplate={handlers.onEditTemplate}
        onImportDraft={handlers.onImportDraft}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("inserts a built-in template's HTML via onApply", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    renderGallery({ onApply });
    await user.click(
      screen.getByTestId("document-template-insert-doc-meeting-notes"),
    );
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0]).toContain("<h1>Meeting notes</h1>");
  });

  it("filters by free-text search", async () => {
    const user = userEvent.setup();
    renderGallery();
    await user.type(
      screen.getByLabelText("Search templates by name or description"),
      "meeting",
    );
    expect(
      screen.getByTestId("document-template-insert-doc-meeting-notes"),
    ).toBeTruthy();
    expect(screen.queryByTestId("document-template-insert-doc-prd")).toBeNull();
  });

  it("filters by category chip", async () => {
    const user = userEvent.setup();
    renderGallery();
    await user.click(screen.getByRole("button", { name: "Engineering" }));
    // A Meetings template is hidden once the Engineering chip is active.
    expect(
      screen.queryByTestId("document-template-insert-doc-meeting-notes"),
    ).toBeNull();
  });

  it("shows the empty state when nothing matches", async () => {
    const user = userEvent.setup();
    renderGallery();
    await user.type(
      screen.getByLabelText("Search templates by name or description"),
      "zzzznomatch",
    );
    expect(screen.getByTestId("document-template-empty")).toBeTruthy();
  });

  it("invokes onSaveCurrent from the Save-current action", async () => {
    const user = userEvent.setup();
    const onSaveCurrent = vi.fn();
    renderGallery({ onSaveCurrent });
    await user.click(screen.getByTestId("document-template-save-current"));
    expect(onSaveCurrent).toHaveBeenCalledTimes(1);
  });

  it("renders the user's saved templates and applies them", async () => {
    const user = userEvent.setup();
    const t = customTemplate({ label: "My saved" });
    seed([t]);
    const onApply = vi.fn();
    renderGallery({ onApply });

    const card = screen.getByTestId(`document-template-custom-${t.id}`);
    expect(within(card).getByText("My saved")).toBeTruthy();
    await user.click(screen.getByTestId(`document-template-apply-${t.id}`));
    expect(onApply).toHaveBeenCalledWith(t.content);
  });

  it("edits a saved template via onEditTemplate", async () => {
    const user = userEvent.setup();
    const t = customTemplate();
    seed([t]);
    const onEditTemplate = vi.fn();
    renderGallery({ onEditTemplate });
    await user.click(screen.getByTestId(`document-template-edit-${t.id}`));
    expect(onEditTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ id: t.id }),
    );
  });

  it("deletes a saved template behind a two-step armed confirm", async () => {
    const user = userEvent.setup();
    const t = customTemplate();
    seed([t]);
    renderGallery();

    // First click arms; the card is still present.
    await user.click(screen.getByTestId(`document-template-delete-${t.id}`));
    expect(
      screen.getByTestId(`document-template-delete-confirm-${t.id}`),
    ).toBeTruthy();

    await user.click(
      screen.getByTestId(`document-template-delete-confirm-${t.id}`),
    );
    expect(screen.queryByTestId(`document-template-custom-${t.id}`)).toBeNull();
  });

  it("duplicates a saved template in place", async () => {
    const user = userEvent.setup();
    const t = customTemplate({ label: "Dupe me" });
    seed([t]);
    renderGallery();
    await user.click(screen.getByTestId(`document-template-duplicate-${t.id}`));
    expect(screen.getByText("Dupe me (copy)")).toBeTruthy();
  });

  it("exports a saved template to a portable file", async () => {
    const user = userEvent.setup();
    const createSpy = vi.spyOn(URL, "createObjectURL");
    const t = customTemplate();
    seed([t]);
    renderGallery();
    await user.click(screen.getByTestId(`document-template-export-${t.id}`));
    expect(createSpy).toHaveBeenCalledTimes(1);
    createSpy.mockRestore();
  });

  it("imports a valid portable file via onImportDraft", async () => {
    const user = userEvent.setup();
    const onImportDraft = vi.fn();
    renderGallery({ onImportDraft });

    const fileBody = serializeDocumentTemplate(
      customTemplate({ label: "Shared doc" }),
    );
    const file = new File([fileBody], "shared.json", {
      type: "application/json",
    });
    await user.upload(
      screen.getByTestId("document-template-import-input"),
      file,
    );

    expect(onImportDraft).toHaveBeenCalledTimes(1);
    expect(onImportDraft.mock.calls[0][0]).toMatchObject({
      label: "Shared doc",
    });
    // Non-destructive: the imported draft never carries an id.
    expect(onImportDraft.mock.calls[0][0].id).toBeUndefined();
  });

  it("surfaces an inline error for an invalid import file", async () => {
    const user = userEvent.setup();
    const onImportDraft = vi.fn();
    renderGallery({ onImportDraft });

    const file = new File(["not json{"], "bad.json", {
      type: "application/json",
    });
    await user.upload(
      screen.getByTestId("document-template-import-input"),
      file,
    );

    expect(
      await screen.findByTestId("document-template-import-error"),
    ).toBeTruthy();
    expect(onImportDraft).not.toHaveBeenCalled();
  });

  it("the exported file carries the document-template format tag", () => {
    const body: unknown = JSON.parse(
      serializeDocumentTemplate(customTemplate()),
    );
    expect(body).toMatchObject({ format: DOCUMENT_TEMPLATE_FORMAT });
  });
});
