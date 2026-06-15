import { describe, expect, it } from "vitest";
import {
  BUILTIN_SKILLS,
  DOCUMENT_DELIBERATE_DRAFT,
  getSkillById,
  getSkillsForSurface,
} from "../skillLibrary";
import { compileStep, initialContext, validateSkill } from "../skillEngine";
import type { SkillSurface } from "../skillTypes";

describe("built-in skill library", () => {
  it("every skill passes structural validation", () => {
    for (const skill of BUILTIN_SKILLS) {
      expect(validateSkill(skill), `skill ${skill.id}`).toEqual([]);
    }
  });

  it("skill ids are unique", () => {
    const ids = BUILTIN_SKILLS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every skill has at least two steps (it is deliberate, not one-shot)", () => {
    for (const skill of BUILTIN_SKILLS) {
      expect(skill.steps.length, skill.id).toBeGreaterThanOrEqual(2);
    }
  });

  it("covers all four editor surfaces", () => {
    const surfaces: SkillSurface[] = ["document", "sheet", "slide", "base"];
    for (const surface of surfaces) {
      expect(getSkillsForSurface(surface).length, surface).toBeGreaterThan(0);
    }
  });

  it("getSkillById resolves known ids and rejects unknown", () => {
    expect(getSkillById("document-deliberate-draft")).toBe(DOCUMENT_DELIBERATE_DRAFT);
    expect(getSkillById("nope")).toBeUndefined();
  });

  it("getSkillsForSurface only returns skills declaring that surface", () => {
    for (const skill of getSkillsForSurface("document")) {
      expect(skill.surfaces).toContain("document");
    }
  });
});

describe("document-deliberate-draft", () => {
  it("threads plan → draft → critique → revise via shared variables", () => {
    const ids = DOCUMENT_DELIBERATE_DRAFT.steps.map((s) => s.id);
    expect(ids).toEqual(["plan", "draft", "critique", "revise"]);

    const kinds = DOCUMENT_DELIBERATE_DRAFT.steps.map((s) => s.kind);
    expect(kinds).toEqual(["plan", "draft", "critique", "revise"]);

    // The draft consumes the plan's output; revise consumes draft + critique.
    const draft = DOCUMENT_DELIBERATE_DRAFT.steps[1];
    expect(draft.inputsFrom).toContain("outline");
    const revise = DOCUMENT_DELIBERATE_DRAFT.steps[3];
    expect(revise.inputsFrom).toEqual(expect.arrayContaining(["draft_text", "critique"]));
    expect(revise.output).toBe("final_text");
  });

  it("compiles its first step into a concrete prompt from inputs", () => {
    const ctx = initialContext(DOCUMENT_DELIBERATE_DRAFT, {
      topic: "Our refund policy",
      context: "Refunds within 30 days.",
    });
    const compiled = compileStep(DOCUMENT_DELIBERATE_DRAFT.steps[0], ctx);
    expect(compiled.prompt).toContain("Our refund policy");
    expect(compiled.prompt).toContain("CONTEXT:");
    expect(compiled.prompt).toContain("Refunds within 30 days.");
    // The planning step uses the low-temperature default.
    expect(compiled.temperature).toBeLessThan(0.5);
  });
});

describe("sheet-intent-formula-selfcheck", () => {
  it("ends on a repaired final formula bound to formula_final", () => {
    const skill = getSkillById("sheet-intent-formula-selfcheck");
    expect(skill).toBeDefined();
    const last = skill!.steps[skill!.steps.length - 1];
    expect(last.output).toBe("formula_final");
    expect(last.inputsFrom).toEqual(expect.arrayContaining(["formula", "formula_check"]));
  });
});
