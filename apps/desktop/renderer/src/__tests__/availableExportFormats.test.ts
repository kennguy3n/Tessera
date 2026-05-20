import { describe, it, expect } from "vitest";
import { availableExportFormats } from "../pages/ArtifactEditorPage";

describe("availableExportFormats", () => {
  it("returns text-oriented formats for documents (no XLSX, no PPTX)", () => {
    const fmts = availableExportFormats("document");
    expect(fmts).toContain("markdown");
    expect(fmts).toContain("docx");
    expect(fmts).toContain("pdf");
    expect(fmts).not.toContain("xlsx");
    expect(fmts).not.toContain("pptx");
    expect(fmts).not.toContain("csv");
  });

  it("returns slide-oriented formats for slides (PPTX yes, DOCX/XLSX/CSV no)", () => {
    const fmts = availableExportFormats("slides");
    expect(fmts).toContain("pptx");
    expect(fmts).toContain("markdown");
    expect(fmts).toContain("pdf");
    expect(fmts).not.toContain("docx");
    expect(fmts).not.toContain("xlsx");
    expect(fmts).not.toContain("csv");
  });

  it("returns sheet-oriented formats for sheets (CSV/XLSX yes, DOCX/PPTX/Markdown no)", () => {
    const fmts = availableExportFormats("sheet");
    expect(fmts).toContain("csv");
    expect(fmts).toContain("xlsx");
    expect(fmts).not.toContain("docx");
    expect(fmts).not.toContain("pptx");
    expect(fmts).not.toContain("markdown");
  });

  it("returns CSV/XLSX for base artifacts", () => {
    const fmts = availableExportFormats("base");
    expect(fmts).toContain("csv");
    expect(fmts).toContain("xlsx");
  });

  it("returns html/json/pdf for infographic (no markdown/csv/docx/pptx/xlsx)", () => {
    const fmts = availableExportFormats("infographic");
    expect(fmts).toEqual(expect.arrayContaining(["html", "json", "pdf"]));
    expect(fmts).not.toContain("docx");
    expect(fmts).not.toContain("pptx");
    expect(fmts).not.toContain("xlsx");
    expect(fmts).not.toContain("csv");
    expect(fmts).not.toContain("markdown");
  });

  it("returns html/json/pdf for landing pages", () => {
    const fmts = availableExportFormats("landing_page");
    expect(fmts).toEqual(expect.arrayContaining(["html", "json", "pdf"]));
    expect(fmts).not.toContain("docx");
    expect(fmts).not.toContain("pptx");
  });

  it("falls back to a safe universal set for unknown types", () => {
    const fmts = availableExportFormats("__future_type__");
    expect(fmts.length).toBeGreaterThan(0);
    expect(fmts).toEqual(expect.arrayContaining(["json", "html", "pdf"]));
    expect(fmts).not.toContain("docx");
    expect(fmts).not.toContain("pptx");
    expect(fmts).not.toContain("xlsx");
  });
});
