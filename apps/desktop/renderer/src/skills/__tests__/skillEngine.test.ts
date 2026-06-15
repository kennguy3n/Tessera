import { describe, expect, it } from "vitest";
import {
  DEFAULT_STEP_MAX_TOKENS,
  DEFAULT_STEP_TEMPERATURE,
  MAX_CONTEXT_VALUE_CHARS,
  STEP_PREAMBLES,
  cleanStepOutput,
  clampMaxTokens,
  clampTemperature,
  compileStep,
  foldStepOutput,
  humanizeVarName,
  initialContext,
  interpolate,
  missingRequiredInputs,
  referencedVars,
  validateSkill,
} from "../skillEngine";
import type { Skill, SkillStep } from "../skillTypes";

describe("interpolate", () => {
  it("substitutes known variables", () => {
    expect(interpolate("Hello {{name}}!", { name: "world" })).toBe(
      "Hello world!",
    );
  });

  it("tolerates surrounding whitespace in the placeholder", () => {
    expect(interpolate("a {{ x }} b", { x: "Y" })).toBe("a Y b");
  });

  it("collapses unknown placeholders to empty string", () => {
    expect(interpolate("x={{missing}}.", {})).toBe("x=.");
  });

  it("substitutes the same variable multiple times", () => {
    expect(interpolate("{{a}}-{{a}}", { a: "1" })).toBe("1-1");
  });

  it("clamps a huge substituted value", () => {
    const big = "z".repeat(MAX_CONTEXT_VALUE_CHARS + 500);
    const out = interpolate("{{v}}", { v: big });
    expect(out.length).toBe(MAX_CONTEXT_VALUE_CHARS);
  });

  it("leaves text without placeholders untouched", () => {
    expect(interpolate("plain text", { a: "1" })).toBe("plain text");
  });
});

describe("referencedVars", () => {
  it("returns distinct referenced names", () => {
    expect(referencedVars("{{a}} {{b}} {{a}}").sort()).toEqual(["a", "b"]);
  });

  it("returns empty for no placeholders", () => {
    expect(referencedVars("nothing here")).toEqual([]);
  });
});

describe("humanizeVarName", () => {
  it("uppercases and replaces separators", () => {
    expect(humanizeVarName("draft_text")).toBe("DRAFT TEXT");
    expect(humanizeVarName("schema-final")).toBe("SCHEMA FINAL");
  });
});

describe("clampTemperature", () => {
  it("clamps into [0, 2]", () => {
    expect(clampTemperature(-1, 0.5)).toBe(0);
    expect(clampTemperature(5, 0.5)).toBe(2);
    expect(clampTemperature(0.8, 0.5)).toBe(0.8);
  });
  it("falls back on NaN", () => {
    expect(clampTemperature(Number.NaN, 0.42)).toBe(0.42);
  });
});

describe("clampMaxTokens", () => {
  it("clamps and rounds", () => {
    expect(clampMaxTokens(0, 100)).toBe(1);
    expect(clampMaxTokens(10_000, 100)).toBe(4096);
    expect(clampMaxTokens(512.7, 100)).toBe(513);
  });
  it("falls back on NaN", () => {
    expect(clampMaxTokens(Number.NaN, 256)).toBe(256);
  });
});

describe("initialContext", () => {
  const skill: Skill = {
    id: "s",
    name: "S",
    description: "",
    surfaces: ["document"],
    inputs: [
      { id: "topic", label: "Topic", required: true },
      { id: "notes", label: "Notes" },
    ],
    steps: [
      { id: "a", title: "A", kind: "draft", instruction: "{{topic}}", output: "o" },
    ],
  };

  it("admits only declared inputs and defaults missing to empty", () => {
    const ctx = initialContext(skill, { topic: "T", stray: "nope" });
    expect(ctx).toEqual({ topic: "T", notes: "" });
    expect("stray" in ctx).toBe(false);
  });

  it("clamps oversized input values", () => {
    const ctx = initialContext(skill, {
      topic: "x".repeat(MAX_CONTEXT_VALUE_CHARS + 10),
    });
    expect(ctx.topic.length).toBe(MAX_CONTEXT_VALUE_CHARS);
  });
});

describe("missingRequiredInputs", () => {
  const skill: Skill = {
    id: "s",
    name: "S",
    description: "",
    surfaces: ["document"],
    inputs: [
      { id: "topic", label: "Topic", required: true },
      { id: "notes", label: "Notes" },
    ],
    steps: [
      { id: "a", title: "A", kind: "draft", instruction: "{{topic}}", output: "o" },
    ],
  };

  it("reports a blank required input", () => {
    expect(missingRequiredInputs(skill, { topic: "  " }).map((m) => m.id)).toEqual([
      "topic",
    ]);
  });

  it("passes when required inputs are present", () => {
    expect(missingRequiredInputs(skill, { topic: "T" })).toEqual([]);
  });

  it("ignores optional inputs", () => {
    expect(missingRequiredInputs(skill, { topic: "T", notes: "" })).toEqual([]);
  });
});

describe("compileStep", () => {
  const baseStep: SkillStep = {
    id: "draft",
    title: "Write the draft",
    kind: "draft",
    instruction: "Write about {{topic}}.",
    inputsFrom: ["outline", "empty_var"],
    output: "draft_text",
    outputContract: "FORMAT: prose.",
  };

  it("assembles preamble, instruction, material blocks, and contract", () => {
    const compiled = compileStep(baseStep, {
      topic: "otters",
      outline: "- intro\n- body",
      empty_var: "   ",
    });
    expect(compiled.prompt).toBe(
      [
        STEP_PREAMBLES.draft,
        "",
        "Write about otters.",
        "",
        "OUTLINE:",
        "- intro\n- body",
        "",
        "FORMAT: prose.",
      ].join("\n"),
    );
  });

  it("skips inputsFrom variables that are empty/whitespace", () => {
    const compiled = compileStep(baseStep, { topic: "x", outline: "", empty_var: "" });
    expect(compiled.prompt).not.toContain("OUTLINE:");
    expect(compiled.prompt).not.toContain("EMPTY VAR:");
  });

  it("applies per-kind default sampling parameters", () => {
    const compiled = compileStep(baseStep, { topic: "x" });
    expect(compiled.temperature).toBe(DEFAULT_STEP_TEMPERATURE.draft);
    expect(compiled.maxTokens).toBe(DEFAULT_STEP_MAX_TOKENS.draft);
  });

  it("honours and clamps explicit overrides", () => {
    const compiled = compileStep(
      { ...baseStep, temperature: 9, maxTokens: 99_999 },
      { topic: "x" },
    );
    expect(compiled.temperature).toBe(2);
    expect(compiled.maxTokens).toBe(4096);
  });

  it("forwards the grammar id and identity fields", () => {
    const compiled = compileStep({ ...baseStep, grammar: "doc.gbnf" }, { topic: "x" });
    expect(compiled.grammar).toBe("doc.gbnf");
    expect(compiled.id).toBe("draft");
    expect(compiled.title).toBe("Write the draft");
    expect(compiled.kind).toBe("draft");
    expect(compiled.output).toBe("draft_text");
  });

  it("omits the contract when absent", () => {
    const { outputContract: _omit, ...noContract } = baseStep;
    const compiled = compileStep({ ...noContract }, { topic: "x", outline: "o" });
    expect(compiled.prompt.endsWith("OUTLINE:\no")).toBe(true);
  });
});

describe("foldStepOutput", () => {
  it("returns a new context with the output bound (immutably)", () => {
    const ctx = { topic: "t" };
    const step: SkillStep = {
      id: "a",
      title: "A",
      kind: "draft",
      instruction: "x",
      output: "draft_text",
    };
    const next = foldStepOutput(ctx, step, "hello");
    expect(next).toEqual({ topic: "t", draft_text: "hello" });
    expect(ctx).toEqual({ topic: "t" });
  });

  it("clamps an oversized output", () => {
    const step: SkillStep = {
      id: "a",
      title: "A",
      kind: "draft",
      instruction: "x",
      output: "o",
    };
    const next = foldStepOutput({}, step, "y".repeat(MAX_CONTEXT_VALUE_CHARS + 5));
    expect(next.o.length).toBe(MAX_CONTEXT_VALUE_CHARS);
  });
});

describe("cleanStepOutput", () => {
  it("strips a wrapping code fence", () => {
    expect(cleanStepOutput("```\nhello\n```")).toBe("hello");
    expect(cleanStepOutput("```ts\nconst x = 1;\n```")).toBe("const x = 1;");
  });

  it("strips a leading conversational label", () => {
    expect(cleanStepOutput("Sure, here's the text: done")).toBe("done");
    expect(cleanStepOutput("Certainly: result")).toBe("result");
  });

  it("strips one pair of wrapping quotes", () => {
    expect(cleanStepOutput('"quoted"')).toBe("quoted");
    expect(cleanStepOutput("\u201ccurly\u201d")).toBe("curly");
  });

  it("does not strip quotes that are not balanced wrappers", () => {
    expect(cleanStepOutput('say "hi" now')).toBe('say "hi" now');
  });

  it("is idempotent", () => {
    const once = cleanStepOutput("```\nSure, here is: value\n```");
    expect(cleanStepOutput(once)).toBe(once);
  });

  it("handles empty / whitespace input", () => {
    expect(cleanStepOutput("")).toBe("");
    expect(cleanStepOutput("   \n  ")).toBe("");
  });
});

describe("validateSkill", () => {
  const good: Skill = {
    id: "good",
    name: "Good",
    description: "",
    surfaces: ["document"],
    inputs: [{ id: "topic", label: "Topic" }],
    steps: [
      { id: "plan", title: "Plan", kind: "plan", instruction: "Plan {{topic}}", output: "outline" },
      {
        id: "draft",
        title: "Draft",
        kind: "draft",
        instruction: "Write {{topic}}",
        inputsFrom: ["outline"],
        output: "draft_text",
      },
    ],
  };

  it("returns no problems for a well-formed skill", () => {
    expect(validateSkill(good)).toEqual([]);
  });

  it("flags an empty step list", () => {
    expect(validateSkill({ ...good, steps: [] })).toContain('skill "good" has no steps');
  });

  it("flags duplicate step ids", () => {
    const dup: Skill = {
      ...good,
      steps: [good.steps[0], { ...good.steps[1], id: "plan" }],
    };
    expect(validateSkill(dup).some((p) => p.includes("duplicate step id"))).toBe(true);
  });

  it("flags duplicate output variables", () => {
    const dup: Skill = {
      ...good,
      steps: [good.steps[0], { ...good.steps[1], output: "outline" }],
    };
    expect(
      validateSkill(dup).some((p) => p.includes("duplicate output variable")),
    ).toBe(true);
  });

  it("flags a reference to a variable produced by no prior step", () => {
    const bad: Skill = {
      ...good,
      steps: [
        {
          id: "draft",
          title: "Draft",
          kind: "draft",
          instruction: "Write {{nonexistent}}",
          output: "draft_text",
        },
      ],
    };
    expect(
      validateSkill(bad).some((p) => p.includes('unknown variable "nonexistent"')),
    ).toBe(true);
  });

  it("flags an inputsFrom reference to a later step's output (ordering)", () => {
    const bad: Skill = {
      ...good,
      steps: [
        {
          id: "plan",
          title: "Plan",
          kind: "plan",
          instruction: "Plan {{topic}}",
          inputsFrom: ["draft_text"],
          output: "outline",
        },
        {
          id: "draft",
          title: "Draft",
          kind: "draft",
          instruction: "Write {{topic}}",
          output: "draft_text",
        },
      ],
    };
    expect(
      validateSkill(bad).some((p) => p.includes('unknown variable "draft_text"')),
    ).toBe(true);
  });

  it("flags blank instruction / output", () => {
    const bad: Skill = {
      ...good,
      steps: [{ id: "a", title: "A", kind: "draft", instruction: "  ", output: "  " }],
    };
    const problems = validateSkill(bad);
    expect(problems.some((p) => p.includes("blank instruction"))).toBe(true);
    expect(problems.some((p) => p.includes("blank output"))).toBe(true);
  });
});
