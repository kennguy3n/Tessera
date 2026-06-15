import { beforeEach, describe, expect, it } from "vitest";
import { validateSkill } from "../skillEngine";
import {
  ALL_SKILL_SURFACES,
  ALL_STEP_KINDS,
  CUSTOM_SKILLS_STORAGE_KEY,
  CUSTOM_SKILL_ID_PREFIX,
  MAX_CUSTOM_SKILLS,
  MAX_SKILL_INPUTS,
  MAX_SKILL_NAME,
  MAX_SKILL_STEPS,
  availableVarsBeforeStep,
  buildCustomSkill,
  emptyDraft,
  isCustomSkillId,
  loadCustomSkills,
  newCustomSkillId,
  normalizeStepKind,
  normalizeSurfaces,
  parseCustomSkillStore,
  parseStoredSkill,
  removeCustomSkill,
  saveCustomSkills,
  serializeCustomSkillStore,
  skillToDraft,
  slugifyVar,
  upsertCustomSkill,
  type CustomSkillDraft,
} from "../customSkills";
import type { Skill } from "../skillTypes";

let idCounter = 0;
const fixedId = () => `${CUSTOM_SKILL_ID_PREFIX}fixed-${++idCounter}`;

function draft(overrides: Partial<CustomSkillDraft> = {}): CustomSkillDraft {
  return {
    name: "My skill",
    description: "Does a thing",
    surfaces: ["document"],
    inputs: [{ id: "topic", label: "Topic", required: true, multiline: false }],
    steps: [
      {
        title: "Draft",
        kind: "draft",
        instruction: "Write about {{topic}}.",
        output: "result",
        inputsFrom: [],
        outputContract: "",
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  idCounter = 0;
  window.localStorage.clear();
});

describe("small pure helpers", () => {
  it("slugifyVar produces engine-safe variable names", () => {
    expect(slugifyVar("Use Case")).toBe("use_case");
    expect(slugifyVar("  Spaces  ")).toBe("spaces");
    expect(slugifyVar("a!!!b")).toBe("a_b");
    expect(slugifyVar("---")).toBe("");
    expect(slugifyVar("Café & Crème")).toBe("caf_cr_me");
  });

  it("isCustomSkillId / newCustomSkillId are namespaced", () => {
    const id = newCustomSkillId();
    expect(id.startsWith(CUSTOM_SKILL_ID_PREFIX)).toBe(true);
    expect(isCustomSkillId(id)).toBe(true);
    expect(isCustomSkillId("document-deliberate-draft")).toBe(false);
  });

  it("normalizeSurfaces keeps valid, dedupes, and canonicalises order", () => {
    expect(normalizeSurfaces(["sheet", "document", "sheet", "bogus"])).toEqual([
      "document",
      "sheet",
    ]);
    expect(normalizeSurfaces("nope")).toEqual([]);
    expect(normalizeSurfaces(undefined)).toEqual([]);
    // Canonical order is independent of input order.
    expect(normalizeSurfaces([...ALL_SKILL_SURFACES].reverse())).toEqual([
      ...ALL_SKILL_SURFACES,
    ]);
  });

  it("normalizeStepKind only accepts known kinds", () => {
    for (const k of ALL_STEP_KINDS) expect(normalizeStepKind(k)).toBe(k);
    expect(normalizeStepKind("nope")).toBeNull();
    expect(normalizeStepKind(42)).toBeNull();
  });
});

describe("buildCustomSkill — happy path", () => {
  it("produces a skill that passes engine validation", () => {
    const result = buildCustomSkill(draft(), fixedId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(validateSkill(result.skill)).toEqual([]);
    expect(result.skill.id).toBe(`${CUSTOM_SKILL_ID_PREFIX}fixed-1`);
    expect(result.skill.steps[0].id).toBe("s1");
    expect(result.skill.surfaces).toEqual(["document"]);
  });

  it("slugifies input ids and step outputs", () => {
    const result = buildCustomSkill(
      draft({
        inputs: [
          { id: "", label: "Use Case", required: false, multiline: true },
        ],
        steps: [
          {
            title: "",
            kind: "plan",
            instruction: "Plan for {{use_case}}.",
            output: "My Plan",
            inputsFrom: [],
            outputContract: "",
          },
        ],
      }),
      fixedId,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skill.inputs[0].id).toBe("use_case");
    expect(result.skill.inputs[0].label).toBe("Use Case");
    expect(result.skill.inputs[0].multiline).toBe(true);
    expect(result.skill.steps[0].output).toBe("my_plan");
    expect(result.skill.steps[0].title).toBe("Step 1"); // blank title filled
  });

  it("keeps only resolvable inputsFrom references and binds outputs forward", () => {
    const result = buildCustomSkill(
      draft({
        inputs: [
          { id: "topic", label: "Topic", required: true, multiline: false },
        ],
        steps: [
          {
            title: "Plan",
            kind: "plan",
            instruction: "Outline {{topic}}.",
            output: "outline",
            inputsFrom: ["topic", "ghost"], // ghost is not produced → dropped
            outputContract: "",
          },
          {
            title: "Draft",
            kind: "draft",
            instruction: "Draft from the outline.",
            output: "draft_text",
            inputsFrom: ["topic", "outline"],
            outputContract: "Return prose only.",
          },
        ],
      }),
      fixedId,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skill.steps[0].inputsFrom).toEqual(["topic"]);
    expect(result.skill.steps[1].inputsFrom).toEqual(["topic", "outline"]);
    expect(result.skill.steps[1].outputContract).toBe("Return prose only.");
  });

  it("clamps long names and preserves an existing custom id when editing", () => {
    const longName = "x".repeat(MAX_SKILL_NAME + 40);
    const result = buildCustomSkill(
      draft({ id: `${CUSTOM_SKILL_ID_PREFIX}keep-me`, name: longName }),
      fixedId,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skill.id).toBe(`${CUSTOM_SKILL_ID_PREFIX}keep-me`);
    expect(result.skill.name.length).toBe(MAX_SKILL_NAME);
  });

  it("ignores a non-custom incoming id (cannot shadow a built-in)", () => {
    const result = buildCustomSkill(
      draft({ id: "document-deliberate-draft" }),
      fixedId,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skill.id).toBe(`${CUSTOM_SKILL_ID_PREFIX}fixed-1`);
  });
});

describe("buildCustomSkill — validation errors", () => {
  it("requires a name", () => {
    const result = buildCustomSkill(draft({ name: "   " }), fixedId);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(" ")).toMatch(/name is required/i);
  });

  it("requires at least one surface", () => {
    const result = buildCustomSkill(draft({ surfaces: [] }), fixedId);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(" ")).toMatch(/at least one surface/i);
  });

  it("requires at least one step with an instruction", () => {
    const empty = buildCustomSkill(draft({ steps: [] }), fixedId);
    expect(empty.ok).toBe(false);

    const blank = buildCustomSkill(
      draft({
        steps: [
          {
            title: "Draft",
            kind: "draft",
            instruction: "   ",
            output: "result",
            inputsFrom: [],
            outputContract: "",
          },
        ],
      }),
      fixedId,
    );
    expect(blank.ok).toBe(false);
    if (blank.ok) return;
    expect(blank.errors.join(" ")).toMatch(/needs an instruction/i);
  });

  it("rejects a dangling {{var}} reference with a friendly message", () => {
    const result = buildCustomSkill(
      draft({
        steps: [
          {
            title: "Draft",
            kind: "draft",
            instruction: "Write about {{missing}}.",
            output: "result",
            inputsFrom: [],
            outputContract: "",
          },
        ],
      }),
      fixedId,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(" ")).toMatch(/\{\{missing\}\}/);
  });

  it("rejects duplicate input variables", () => {
    const result = buildCustomSkill(
      draft({
        inputs: [
          { id: "topic", label: "Topic", required: false, multiline: false },
          { id: "topic", label: "Topic 2", required: false, multiline: false },
        ],
      }),
      fixedId,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(" ")).toMatch(/duplicate input/i);
  });

  it("rejects exceeding the step and input caps", () => {
    const tooManySteps = buildCustomSkill(
      draft({
        steps: Array.from({ length: MAX_SKILL_STEPS + 1 }, (_, i) => ({
          title: `S${i}`,
          kind: "draft" as const,
          instruction: "Do work.",
          output: `out_${i}`,
          inputsFrom: [],
          outputContract: "",
        })),
      }),
      fixedId,
    );
    expect(tooManySteps.ok).toBe(false);

    const tooManyInputs = buildCustomSkill(
      draft({
        inputs: Array.from({ length: MAX_SKILL_INPUTS + 1 }, (_, i) => ({
          id: `in_${i}`,
          label: `In ${i}`,
          required: false,
          multiline: false,
        })),
      }),
      fixedId,
    );
    expect(tooManyInputs.ok).toBe(false);
  });

  it("de-collides a step output that matches an input or earlier output", () => {
    const result = buildCustomSkill(
      draft({
        inputs: [
          { id: "topic", label: "Topic", required: false, multiline: false },
        ],
        steps: [
          {
            title: "One",
            kind: "draft",
            instruction: "Use {{topic}}.",
            output: "topic", // collides with the input
            inputsFrom: [],
            outputContract: "",
          },
        ],
      }),
      fixedId,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skill.steps[0].output).not.toBe("topic");
    expect(validateSkill(result.skill)).toEqual([]);
  });
});

describe("draft helpers", () => {
  it("emptyDraft seeds the chosen surface and becomes buildable once filled in", () => {
    const d = emptyDraft("slide");
    expect(d.surfaces).toEqual(["slide"]);
    // A fresh draft has a blank name + instruction, so it is intentionally not yet valid.
    expect(buildCustomSkill(d, fixedId).ok).toBe(false);
    d.name = "My deck skill";
    d.steps[0].instruction = "Outline the deck.";
    expect(buildCustomSkill(d, fixedId).ok).toBe(true);
  });

  it("skillToDraft round-trips through buildCustomSkill preserving the id", () => {
    const built = buildCustomSkill(draft(), fixedId);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const back = skillToDraft(built.skill);
    expect(back.id).toBe(built.skill.id);
    const rebuilt = buildCustomSkill(back, fixedId);
    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) return;
    expect(rebuilt.skill.id).toBe(built.skill.id);
    expect(rebuilt.skill.steps).toEqual(built.skill.steps);
  });

  it("availableVarsBeforeStep exposes inputs + prior outputs only", () => {
    const d = draft({
      inputs: [
        { id: "topic", label: "Topic", required: false, multiline: false },
      ],
      steps: [
        {
          title: "Plan",
          kind: "plan",
          instruction: "{{topic}}",
          output: "outline",
          inputsFrom: [],
          outputContract: "",
        },
        {
          title: "Draft",
          kind: "draft",
          instruction: "{{outline}}",
          output: "draft_text",
          inputsFrom: [],
          outputContract: "",
        },
      ],
    });
    expect(availableVarsBeforeStep(d, 0)).toEqual(["topic"]);
    expect(availableVarsBeforeStep(d, 1)).toEqual(["topic", "outline"]);
  });
});

describe("CRUD over a skills array", () => {
  const mk = (id: string): Skill => ({
    id,
    name: id,
    description: "",
    surfaces: ["document"],
    inputs: [],
    steps: [
      { id: "s1", title: "t", kind: "draft", instruction: "go", output: "o" },
    ],
  });

  it("upsert replaces in place and appends new", () => {
    const a = mk(`${CUSTOM_SKILL_ID_PREFIX}a`);
    const b = mk(`${CUSTOM_SKILL_ID_PREFIX}b`);
    const list = upsertCustomSkill(upsertCustomSkill([], a), b);
    expect(list.map((s) => s.id)).toEqual([a.id, b.id]);

    const a2 = { ...a, name: "renamed" };
    const replaced = upsertCustomSkill(list, a2);
    expect(replaced.map((s) => s.id)).toEqual([a.id, b.id]); // order kept
    expect(replaced[0].name).toBe("renamed");
  });

  it("upsert enforces MAX_CUSTOM_SKILLS by dropping the oldest", () => {
    let list: Skill[] = [];
    for (let i = 0; i < MAX_CUSTOM_SKILLS + 5; i++) {
      list = upsertCustomSkill(list, mk(`${CUSTOM_SKILL_ID_PREFIX}${i}`));
    }
    expect(list.length).toBe(MAX_CUSTOM_SKILLS);
    expect(list[0].id).toBe(`${CUSTOM_SKILL_ID_PREFIX}5`); // 0..4 dropped
  });

  it("remove drops by id and is a no-op when absent", () => {
    const a = mk(`${CUSTOM_SKILL_ID_PREFIX}a`);
    expect(removeCustomSkill([a], a.id)).toEqual([]);
    expect(removeCustomSkill([a], "nope")).toEqual([a]);
  });
});

describe("defensive persistence", () => {
  it("parseStoredSkill rejects non-custom ids and coerces valid ones", () => {
    expect(parseStoredSkill({ id: "builtin-x", name: "n" })).toBeNull();
    expect(parseStoredSkill(null)).toBeNull();
    expect(parseStoredSkill("nope")).toBeNull();

    const built = buildCustomSkill(draft(), fixedId);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const reparsed = parseStoredSkill(JSON.parse(JSON.stringify(built.skill)));
    expect(reparsed).not.toBeNull();
    expect(reparsed!.id).toBe(built.skill.id);
  });

  it("parseCustomSkillStore tolerates garbage and drops bad/duplicate entries", () => {
    expect(parseCustomSkillStore(null)).toBeNull();
    expect(parseCustomSkillStore("{not json")).toBeNull();
    expect(
      parseCustomSkillStore(JSON.stringify({ version: 99, skills: [] })),
    ).toBeNull();
    expect(
      parseCustomSkillStore(JSON.stringify({ version: 1, skills: "x" })),
    ).toBeNull();

    const good = buildCustomSkill(draft(), fixedId);
    expect(good.ok).toBe(true);
    if (!good.ok) return;
    const raw = serializeCustomSkillStore([
      good.skill,
      good.skill, // duplicate id → dropped
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { id: "builtin-x", name: "bad" } as any, // non-custom → dropped
    ]);
    const parsed = parseCustomSkillStore(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.map((s) => s.id)).toEqual([good.skill.id]);
  });

  it("save → load round-trips through localStorage", () => {
    const built = buildCustomSkill(draft(), fixedId);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    saveCustomSkills([built.skill]);
    expect(window.localStorage.getItem(CUSTOM_SKILLS_STORAGE_KEY)).toContain(
      built.skill.id,
    );
    const loaded = loadCustomSkills();
    expect(loaded.map((s) => s.id)).toEqual([built.skill.id]);
  });

  it("loadCustomSkills returns [] when storage is empty or corrupt", () => {
    expect(loadCustomSkills()).toEqual([]);
    window.localStorage.setItem(CUSTOM_SKILLS_STORAGE_KEY, "{broken");
    expect(loadCustomSkills()).toEqual([]);
  });
});
