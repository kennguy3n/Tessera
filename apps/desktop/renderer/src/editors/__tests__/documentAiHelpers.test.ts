import { describe, it, expect } from "vitest";
import {
  DOCUMENT_AI_ACTIONS,
  DOCUMENT_AI_TONES,
  aiResultToHtml,
  buildAiPrompt,
  canRunAction,
  cleanModelOutput,
  computeWordDiff,
  getDocumentAiAction,
  parseBulletLines,
} from "../ai/documentAiHelpers";
import type { DiffSegment } from "../ai/documentAiTypes";

describe("DOCUMENT_AI_ACTIONS catalog", () => {
  it("has unique ids", () => {
    const ids = DOCUMENT_AI_ACTIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("exposes a lookup that returns undefined for unknown ids", () => {
    expect(getDocumentAiAction("improve")?.label).toBe("Improve writing");
    // @ts-expect-error testing an unknown id at runtime
    expect(getDocumentAiAction("nope")).toBeUndefined();
  });

  it("includes a custom 'Ask AI' action that needs no selection", () => {
    const custom = getDocumentAiAction("custom");
    expect(custom?.needsSelection).toBe(false);
  });

  it("ships the documented tone presets", () => {
    expect(DOCUMENT_AI_TONES.map((t) => t.id)).toContain("professional");
    expect(DOCUMENT_AI_TONES.length).toBeGreaterThanOrEqual(4);
  });
});

describe("canRunAction", () => {
  it("requires non-empty selection for selection actions", () => {
    expect(canRunAction("improve", "")).toBe(false);
    expect(canRunAction("improve", "   ")).toBe(false);
    expect(canRunAction("improve", "hello")).toBe(true);
  });

  it("always allows non-selection actions", () => {
    expect(canRunAction("continue", "")).toBe(true);
    expect(canRunAction("custom", "")).toBe(true);
  });

  it("returns false for unknown actions", () => {
    // @ts-expect-error runtime guard
    expect(canRunAction("bogus", "text")).toBe(false);
  });
});

describe("buildAiPrompt", () => {
  it("embeds selection under a TEXT sentinel for edit actions", () => {
    const prompt = buildAiPrompt({ action: "improve", selection: "teh cat" });
    expect(prompt).toContain("Improve the writing");
    expect(prompt).toContain("TEXT:");
    expect(prompt).toContain("teh cat");
  });

  it("names the chosen tone for the tone action", () => {
    const prompt = buildAiPrompt({
      action: "tone",
      selection: "hi",
      tone: "academic",
    });
    expect(prompt.toLowerCase()).toContain("academic");
  });

  it("names the target language for translate", () => {
    const prompt = buildAiPrompt({
      action: "translate",
      selection: "hello",
      language: "French",
    });
    expect(prompt).toContain("French");
  });

  it("defaults translate language to English when omitted", () => {
    const prompt = buildAiPrompt({ action: "translate", selection: "x" });
    expect(prompt).toContain("English");
  });

  it("uses the preceding-text window for continue", () => {
    const prompt = buildAiPrompt({
      action: "continue",
      selection: "",
      precedingText: "Once upon a time",
    });
    expect(prompt).toContain("TEXT SO FAR:");
    expect(prompt).toContain("Once upon a time");
    expect(prompt).toContain("Continue writing");
  });

  it("uses the user instruction as the task for custom", () => {
    const prompt = buildAiPrompt({
      action: "custom",
      selection: "",
      instruction: "Write a haiku about rain",
    });
    expect(prompt).toContain("Write a haiku about rain");
  });

  it("folds extra instructions into non-custom actions", () => {
    const prompt = buildAiPrompt({
      action: "improve",
      selection: "teh cat",
      instruction: "keep it under 10 words",
    });
    // The fixed task template is still present...
    expect(prompt).toContain("Improve the writing");
    // ...and the user's extra guidance is honoured rather than dropped.
    expect(prompt).toContain(
      "Additional instruction from the user: keep it under 10 words",
    );
  });

  it("does not duplicate the instruction for custom actions", () => {
    const prompt = buildAiPrompt({
      action: "custom",
      selection: "",
      instruction: "Write a haiku about rain",
    });
    // For custom the instruction IS the task; it must not also be appended
    // as an "Additional instruction" line.
    expect(prompt).not.toContain("Additional instruction from the user:");
  });

  it("ignores blank/whitespace extra instructions for non-custom actions", () => {
    const prompt = buildAiPrompt({
      action: "fix",
      selection: "teh cat",
      instruction: "   ",
    });
    expect(prompt).not.toContain("Additional instruction from the user:");
  });

  it("is deterministic for identical input", () => {
    const a = buildAiPrompt({ action: "improve", selection: "wrold" });
    const b = buildAiPrompt({ action: "fix", selection: "wrold" });
    const c = buildAiPrompt({ action: "fix", selection: "wrold" });
    expect(b).toBe(c);
    expect(a).not.toBe(b);
  });

  it("clamps very long selections", () => {
    const long = "x".repeat(20000);
    const prompt = buildAiPrompt({ action: "improve", selection: long });
    // 8000 cap on selection + the fixed preamble/task text
    expect(prompt.length).toBeLessThan(9000);
  });
});

describe("cleanModelOutput", () => {
  it("strips wrapping code fences", () => {
    expect(cleanModelOutput("```\nhello world\n```")).toBe("hello world");
    expect(cleanModelOutput("```md\n# Title\n```")).toBe("# Title");
  });

  it("removes a leading conversational label", () => {
    expect(cleanModelOutput("Sure, here's the rewrite: Better text")).toBe(
      "Better text",
    );
    expect(cleanModelOutput("Certainly! The summary: A short recap")).toBe(
      "A short recap",
    );
  });

  it("strips a single pair of wrapping quotes", () => {
    expect(cleanModelOutput('"Quoted line"')).toBe("Quoted line");
    expect(cleanModelOutput("\u201cSmart quotes\u201d")).toBe("Smart quotes");
  });

  it("does not strip quotes when inner text has its own quotes", () => {
    expect(cleanModelOutput('"a" and "b"')).toBe('"a" and "b"');
  });

  it("is idempotent on clean text", () => {
    const clean = "Just plain text.";
    expect(cleanModelOutput(clean)).toBe(clean);
    expect(cleanModelOutput(cleanModelOutput(clean))).toBe(clean);
  });

  it("handles empty input", () => {
    expect(cleanModelOutput("")).toBe("");
    expect(cleanModelOutput("   ")).toBe("");
  });
});

describe("parseBulletLines", () => {
  it("strips bullet/number markers and blank lines", () => {
    const lines = parseBulletLines("- one\n* two\n1. three\n\n• four");
    expect(lines).toEqual(["one", "two", "three", "four"]);
  });

  it("returns empty for empty input", () => {
    expect(parseBulletLines("")).toEqual([]);
  });
});

describe("aiResultToHtml", () => {
  it("builds a <ul> for the bullets action", () => {
    const html = aiResultToHtml("- a\n- b", "bullets");
    expect(html).toBe("<ul><li>a</li><li>b</li></ul>");
  });

  it("builds paragraphs split on blank lines", () => {
    const html = aiResultToHtml("para one\n\npara two", "improve");
    expect(html).toBe("<p>para one</p><p>para two</p>");
  });

  it("turns single newlines into <br>", () => {
    expect(aiResultToHtml("line1\nline2", "improve")).toBe(
      "<p>line1<br>line2</p>",
    );
  });

  it("escapes HTML to prevent injection", () => {
    const html = aiResultToHtml("<script>alert(1)</script>", "improve");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("returns an empty paragraph for empty input", () => {
    expect(aiResultToHtml("", "improve")).toBe("<p></p>");
    expect(aiResultToHtml("   ", "bullets")).toBe("<p></p>");
  });
});

describe("computeWordDiff", () => {
  const kinds = (segs: DiffSegment[]) => segs.map((s) => s.kind);
  const reconstruct = (segs: DiffSegment[], kind: DiffSegment["kind"][]) =>
    segs
      .filter((s) => kind.includes(s.kind))
      .map((s) => s.value)
      .join("");

  it("returns a single equal segment for identical text", () => {
    expect(computeWordDiff("same text", "same text")).toEqual([
      { kind: "equal", value: "same text" },
    ]);
  });

  it("marks pure additions", () => {
    const diff = computeWordDiff("", "brand new");
    expect(diff).toEqual([{ kind: "added", value: "brand new" }]);
  });

  it("marks pure removals", () => {
    const diff = computeWordDiff("gone now", "");
    expect(diff).toEqual([{ kind: "removed", value: "gone now" }]);
  });

  it("reconstructs both sides from the segments", () => {
    const before = "the quick brown fox";
    const after = "the slow brown cat";
    const diff = computeWordDiff(before, after);
    expect(reconstruct(diff, ["equal", "removed"])).toBe(before);
    expect(reconstruct(diff, ["equal", "added"])).toBe(after);
  });

  it("keeps shared words as equal runs", () => {
    const diff = computeWordDiff("hello world", "hello there world");
    expect(kinds(diff)).toContain("equal");
    expect(kinds(diff)).toContain("added");
  });

  it("degrades to whole-text replace past the size cap", () => {
    const before = Array.from({ length: 1300 }, (_, i) => `a${i}`).join(" ");
    const after = Array.from({ length: 1300 }, (_, i) => `b${i}`).join(" ");
    const diff = computeWordDiff(before, after);
    expect(diff).toEqual([
      { kind: "removed", value: before },
      { kind: "added", value: after },
    ]);
  });
});
