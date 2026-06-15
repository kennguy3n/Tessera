import { beforeEach, describe, expect, it } from "vitest";
import { validateSkill } from "../skillEngine";
import {
  ALL_SKILL_SURFACES,
  ALL_STEP_KINDS,
  CUSTOM_SKILLS_STORAGE_KEY,
  CUSTOM_SKILL_ID_PREFIX,
  MAX_CHECK_MAX_CHARS,
  MAX_CHECK_MIN_LINES,
  MAX_CHECK_TERM,
  MAX_CHECK_TERMS,
  MAX_CUSTOM_SKILLS,
  MAX_SKILL_INPUTS,
  MAX_SKILL_NAME,
  MAX_SKILL_STEPS,
  MAX_STEP_OUTPUT_CONTRACT,
  availableVarsBeforeStep,
  buildCustomSkill,
  buildStepCheck,
  checkToDraft,
  emptyCheckDraft,
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
  type CustomCheckDraft,
  type CustomSkillDraft,
} from "../customSkills";
import { getSkillById } from "../skillLibrary";
import type { Skill, SkillStepCheck } from "../skillTypes";

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
      { id: "builtin-x", name: "bad" } as unknown as Skill, // non-custom → dropped
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

describe("acceptance check authoring — buildStepCheck", () => {
  function checkDraft(
    overrides: Partial<CustomCheckDraft> = {},
  ): CustomCheckDraft {
    return { ...emptyCheckDraft(), ...overrides };
  }

  it("returns no check (and no errors) for an all-empty / undefined draft", () => {
    expect(buildStepCheck(undefined)).toEqual({ errors: [] });
    expect(buildStepCheck(emptyCheckDraft())).toEqual({ errors: [] });
  });

  it("emits only the fields the author actually set", () => {
    const { check, errors } = buildStepCheck(
      checkDraft({ nonEmpty: true, forbidFences: true }),
    );
    expect(errors).toEqual([]);
    expect(check).toEqual({ nonEmpty: true, forbidFences: true });
    // Unset booleans/strings never appear (keeps the persisted blob minimal).
    expect(check).not.toHaveProperty("minLines");
    expect(check).not.toHaveProperty("mustStartWith");
  });

  it("parses numeric fields and preserves the exact prefix (case-sensitive)", () => {
    const { check, errors } = buildStepCheck(
      checkDraft({ minLines: "3", maxChars: "200", mustStartWith: "=SUM(" }),
    );
    expect(errors).toEqual([]);
    expect(check).toEqual({
      minLines: 3,
      maxChars: 200,
      mustStartWith: "=SUM(",
    });
  });

  it("splits list fields by line, drops blank lines, dedupes, keeps content verbatim", () => {
    const { check } = buildStepCheck(
      checkDraft({
        // Whitespace inside a term is significant to the engine, so it is
        // preserved (only whitespace-only lines are dropped). The two "## "
        // lines are identical and collapse to one.
        mustInclude: "## \n\nIntro\n## ",
        forbidContains: "TODO\nTODO\n  FIXME  ",
      }),
    );
    expect(check?.mustInclude).toEqual(["## ", "Intro"]);
    expect(check?.forbidContains).toEqual(["TODO", "  FIXME  "]);
  });

  it("caps a list at MAX_CHECK_TERMS terms", () => {
    const many = Array.from({ length: MAX_CHECK_TERMS + 5 }, (_, i) => `t${i}`);
    const { check } = buildStepCheck(
      checkDraft({ mustInclude: many.join("\n") }),
    );
    expect(check?.mustInclude).toHaveLength(MAX_CHECK_TERMS);
    expect(check?.mustInclude?.[0]).toBe("t0");
  });

  it("clamps an over-long term to MAX_CHECK_TERM characters", () => {
    const long = "x".repeat(MAX_CHECK_TERM + 50);
    const { check } = buildStepCheck(checkDraft({ mustStartWith: long }));
    expect(check?.mustStartWith?.length).toBe(MAX_CHECK_TERM);
  });

  it("reports a friendly error for non-numeric / out-of-range numbers", () => {
    const bad = buildStepCheck(
      checkDraft({
        minLines: "abc",
        maxChars: String(MAX_CHECK_MAX_CHARS + 1),
      }),
    );
    expect(bad.check).toBeUndefined();
    expect(bad.errors).toHaveLength(2);
    expect(bad.errors[0]).toMatch(
      new RegExp(`whole number from 1 to ${MAX_CHECK_MIN_LINES}`),
    );
    expect(bad.errors[1]).toMatch(
      new RegExp(`whole number from 1 to ${MAX_CHECK_MAX_CHARS}`),
    );
  });

  it("rejects zero and negative numbers (only 1..max are valid)", () => {
    expect(buildStepCheck(checkDraft({ minLines: "0" })).errors).toHaveLength(
      1,
    );
    expect(buildStepCheck(checkDraft({ maxChars: "-4" })).errors).toHaveLength(
      1,
    );
  });

  it("surfaces a step-prefixed check error through buildCustomSkill", () => {
    const result = buildCustomSkill(
      draft({
        steps: [
          {
            title: "Draft",
            kind: "draft",
            instruction: "Write about {{topic}}.",
            output: "result",
            inputsFrom: [],
            outputContract: "",
            check: { ...emptyCheckDraft(), minLines: "not-a-number" },
          },
        ],
      }),
      fixedId,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(" ")).toMatch(/Step 1 \("Draft"\) check:/);
  });

  it("a valid authored check survives buildCustomSkill onto the step", () => {
    const result = buildCustomSkill(
      draft({
        surfaces: ["sheet"],
        steps: [
          {
            title: "Formula",
            kind: "draft",
            instruction: "Write a formula for {{topic}}.",
            output: "formula",
            inputsFrom: [],
            outputContract: "",
            check: {
              ...emptyCheckDraft(),
              nonEmpty: true,
              mustStartWith: "=",
            },
          },
        ],
      }),
      fixedId,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skill.steps[0].check).toEqual({
      nonEmpty: true,
      mustStartWith: "=",
    });
    expect(validateSkill(result.skill)).toEqual([]);
  });
});

describe("acceptance check authoring — round-trips", () => {
  it("checkToDraft is the inverse of buildStepCheck for a populated check", () => {
    const original: SkillStepCheck = {
      nonEmpty: true,
      forbidFences: true,
      minLines: 2,
      maxChars: 500,
      mustStartWith: "## ",
      mustInclude: ["alpha", "beta"],
      forbidContains: ["TODO"],
    };
    const rebuilt = buildStepCheck(checkToDraft(original)).check;
    expect(rebuilt).toEqual(original);
  });

  it("checkToDraft is defensive against arbitrary stored JSON", () => {
    expect(checkToDraft(undefined)).toEqual(emptyCheckDraft());
    expect(checkToDraft(null)).toEqual(emptyCheckDraft());
    expect(checkToDraft([1, 2, 3])).toEqual(emptyCheckDraft());
    expect(
      checkToDraft({ minLines: -1, maxChars: NaN, mustInclude: "not-array" }),
    ).toEqual(emptyCheckDraft());
  });

  it("skillToDraft preserves a built-in's checks so a duplicate keeps them", () => {
    const sheet = getSkillById("sheet-intent-formula-selfcheck");
    expect(sheet).toBeDefined();
    if (!sheet) return;
    const back = buildCustomSkill(skillToDraft(sheet), fixedId);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    // The "propose" + "repair" steps require an "=" prefix in the built-in.
    expect(back.skill.steps[0].check).toEqual({
      nonEmpty: true,
      mustStartWith: "=",
    });
    expect(back.skill.steps[2].check).toEqual({
      nonEmpty: true,
      mustStartWith: "=",
    });
  });

  it("a custom skill's checks survive a full localStorage save/load round-trip", () => {
    const built = buildCustomSkill(
      draft({
        surfaces: ["slide"],
        steps: [
          {
            title: "Outline",
            kind: "plan",
            instruction: "Outline {{topic}}.",
            output: "outline",
            inputsFrom: [],
            outputContract: "",
            check: {
              ...emptyCheckDraft(),
              nonEmpty: true,
              forbidFences: true,
              mustInclude: "## ",
            },
          },
        ],
      }),
      fixedId,
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    saveCustomSkills([built.skill]);
    const [loaded] = loadCustomSkills();
    // The trailing space in "## " is significant to the engine, so it must
    // survive the round-trip verbatim.
    expect(loaded.steps[0].check).toEqual({
      nonEmpty: true,
      forbidFences: true,
      mustInclude: ["## "],
    });
    // And re-editing the loaded skill keeps the check in the draft.
    expect(skillToDraft(loaded).steps[0].check).toEqual({
      ...emptyCheckDraft(),
      nonEmpty: true,
      forbidFences: true,
      mustInclude: "## ",
    });
  });
});

describe("step sampling authoring — buildCustomSkill", () => {
  const sampledDraft = (temperature: string, maxTokens: string) =>
    draft({
      steps: [
        {
          title: "Draft",
          kind: "draft",
          instruction: "Write about {{topic}}.",
          output: "result",
          inputsFrom: [],
          outputContract: "",
          temperature,
          maxTokens,
        },
      ],
    });

  it("parses authored temperature + max tokens onto the step", () => {
    const built = buildCustomSkill(sampledDraft("0.2", "800"), fixedId);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.skill.steps[0].temperature).toBe(0.2);
    expect(built.skill.steps[0].maxTokens).toBe(800);
  });

  it("omits sampling overrides when the fields are blank", () => {
    const built = buildCustomSkill(sampledDraft("", ""), fixedId);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect("temperature" in built.skill.steps[0]).toBe(false);
    expect("maxTokens" in built.skill.steps[0]).toBe(false);
  });

  it("preserves an explicit temperature of 0 (not treated as blank)", () => {
    const built = buildCustomSkill(sampledDraft("0", ""), fixedId);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.skill.steps[0].temperature).toBe(0);
  });

  it("rejects an out-of-range or non-numeric temperature", () => {
    for (const bad of ["3", "-0.5", "abc", "1e3"]) {
      const built = buildCustomSkill(sampledDraft(bad, ""), fixedId);
      expect(built.ok).toBe(false);
      if (built.ok) return;
      expect(built.errors.some((e) => /temperature/i.test(e))).toBe(true);
    }
  });

  it("rejects a non-integer or out-of-range max tokens", () => {
    for (const bad of ["0", "5000", "1.5", "abc"]) {
      const built = buildCustomSkill(sampledDraft("", bad), fixedId);
      expect(built.ok).toBe(false);
      if (built.ok) return;
      expect(built.errors.some((e) => /max tokens/i.test(e))).toBe(true);
    }
  });

  it("accepts the exact engine bounds (temperature 2, max tokens 4096 and 1)", () => {
    const high = buildCustomSkill(sampledDraft("2", "4096"), fixedId);
    expect(high.ok).toBe(true);
    if (!high.ok) return;
    expect(high.skill.steps[0].temperature).toBe(2);
    expect(high.skill.steps[0].maxTokens).toBe(4096);

    const low = buildCustomSkill(sampledDraft("0", "1"), fixedId);
    expect(low.ok).toBe(true);
    if (!low.ok) return;
    expect(low.skill.steps[0].maxTokens).toBe(1);
  });
});

describe("step sampling authoring — round-trips", () => {
  it("skillToDraft renders sampling overrides as editable strings", () => {
    const skill: Skill = {
      id: `${CUSTOM_SKILL_ID_PREFIX}sampling`,
      name: "Sampling",
      description: "",
      surfaces: ["document"],
      inputs: [{ id: "topic", label: "Topic" }],
      steps: [
        {
          id: "s1",
          title: "Draft",
          kind: "draft",
          instruction: "Write about {{topic}}.",
          output: "result",
          temperature: 0.7,
          maxTokens: 1024,
        },
      ],
    };
    const back = skillToDraft(skill);
    expect(back.steps[0].temperature).toBe("0.7");
    expect(back.steps[0].maxTokens).toBe("1024");
  });

  it("leaves the sampling fields blank for a step with no overrides", () => {
    const back = skillToDraft({
      id: `${CUSTOM_SKILL_ID_PREFIX}plain`,
      name: "Plain",
      description: "",
      surfaces: ["document"],
      inputs: [{ id: "topic", label: "Topic" }],
      steps: [
        {
          id: "s1",
          title: "Draft",
          kind: "draft",
          instruction: "Write {{topic}}.",
          output: "result",
        },
      ],
    });
    expect(back.steps[0].temperature).toBe("");
    expect(back.steps[0].maxTokens).toBe("");
  });

  it("duplicating a skill with sampling overrides keeps them losslessly", () => {
    const built = buildCustomSkill(
      draft({
        steps: [
          {
            title: "Draft",
            kind: "draft",
            instruction: "Write {{topic}}.",
            output: "result",
            inputsFrom: [],
            outputContract: "",
            temperature: "0.1",
            maxTokens: "1500",
          },
        ],
      }),
      fixedId,
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    // Re-hydrate the saved skill into a draft (the duplicate path) and rebuild.
    const rebuilt = buildCustomSkill(skillToDraft(built.skill), fixedId);
    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) return;
    expect(rebuilt.skill.steps[0].temperature).toBe(0.1);
    expect(rebuilt.skill.steps[0].maxTokens).toBe(1500);
  });

  it("sampling overrides survive a full localStorage save/load round-trip", () => {
    const built = buildCustomSkill(
      draft({
        steps: [
          {
            title: "Draft",
            kind: "draft",
            instruction: "Write {{topic}}.",
            output: "result",
            inputsFrom: [],
            outputContract: "",
            temperature: "0.3",
            maxTokens: "640",
          },
        ],
      }),
      fixedId,
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    saveCustomSkills([built.skill]);
    const [loaded] = loadCustomSkills();
    expect(loaded.steps[0].temperature).toBe(0.3);
    expect(loaded.steps[0].maxTokens).toBe(640);
    expect(skillToDraft(loaded).steps[0].temperature).toBe("0.3");
    expect(skillToDraft(loaded).steps[0].maxTokens).toBe("640");
  });
});

describe("step output contract authoring", () => {
  const contractDraft = (outputContract: string) =>
    draft({
      steps: [
        {
          title: "Draft",
          kind: "draft",
          instruction: "Write about {{topic}}.",
          output: "result",
          inputsFrom: [],
          outputContract,
        },
      ],
    });

  it("sets an authored output contract on the built step", () => {
    const built = buildCustomSkill(
      contractDraft("FORMAT: one '- ' bullet per line."),
      fixedId,
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.skill.steps[0].outputContract).toBe(
      "FORMAT: one '- ' bullet per line.",
    );
  });

  it("omits the output contract when blank or whitespace-only", () => {
    for (const blank of ["", "   ", "\n\t"]) {
      const built = buildCustomSkill(contractDraft(blank), fixedId);
      expect(built.ok).toBe(true);
      if (!built.ok) return;
      expect("outputContract" in built.skill.steps[0]).toBe(false);
    }
  });

  it("clamps an over-long contract to MAX_STEP_OUTPUT_CONTRACT", () => {
    const built = buildCustomSkill(
      contractDraft("x".repeat(MAX_STEP_OUTPUT_CONTRACT + 50)),
      fixedId,
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.skill.steps[0].outputContract?.length).toBe(
      MAX_STEP_OUTPUT_CONTRACT,
    );
  });

  it("preserves internal newlines in a multiline contract", () => {
    const built = buildCustomSkill(
      contractDraft("Line one.\nLine two."),
      fixedId,
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.skill.steps[0].outputContract).toBe("Line one.\nLine two.");
  });

  it("round-trips a built-in's contract through skillToDraft and rebuild", () => {
    const doc = getSkillById("document-deliberate-draft");
    expect(doc).toBeDefined();
    if (!doc) return;
    const back = skillToDraft(doc);
    expect(back.steps[0].outputContract).toBe(doc.steps[0].outputContract);
    const rebuilt = buildCustomSkill(back, fixedId);
    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) return;
    expect(rebuilt.skill.steps[0].outputContract).toBe(
      doc.steps[0].outputContract,
    );
  });

  it("output contract survives a full localStorage save/load round-trip", () => {
    const built = buildCustomSkill(
      contractDraft("FORMAT: JSON object only."),
      fixedId,
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    saveCustomSkills([built.skill]);
    const [loaded] = loadCustomSkills();
    expect(loaded.steps[0].outputContract).toBe("FORMAT: JSON object only.");
    expect(skillToDraft(loaded).steps[0].outputContract).toBe(
      "FORMAT: JSON object only.",
    );
  });
});
