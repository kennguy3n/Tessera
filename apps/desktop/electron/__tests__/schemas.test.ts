/**
 * Unit tests for the zod schemas used at the IPC boundary
 * (`apps/desktop/electron/ipc/schemas.ts`).
 *
 * Every IPC handler that accepts a structured object from the renderer
 * runs the raw payload through one of these schemas before forwarding
 * to the Rust bridge. The tests below exercise both the happy path
 * (a valid payload survives `.parse()` unchanged) and the rejection
 * paths so a regression that loosened a constraint would be caught.
 */
import { describe, it, expect } from "vitest";
import {
  AddCitationSchema,
  AutomationActionSchema,
  AutomationTriggerSchema,
  ReplaceCitationSchema,
  CreateTaskSchema,
  UpdateTaskSchema,
  CreateAutomationSchema,
  SettingsUpdateSchema,
  ExternalProviderConfigSchema,
  GenerateRequestSchema,
  TypstExportSchema,
  MarpExportSchema,
  GdriveSelectedItemsSchema,
  SaveDialogOptionsSchema,
} from "../ipc/schemas";
import {
  TASK_STATUSES,
  TASK_PRIORITIES,
  THEMES,
  EXPORT_FORMATS,
} from "../../shared/types";

const VALID_ADD_CITATION = {
  artifactId: "artifact-1",
  sourceId: "source-1",
  sourceType: "local_file",
  sourceTitle: "doc.md",
  sourceUri: "file:///doc.md",
  chunkHash: "abc123",
  page: null,
  confidence: 0.9,
  usedFor: "summary",
};

const { usedFor: _unusedForReplace, ...REPLACE_BASE } = VALID_ADD_CITATION;
const VALID_REPLACE_CITATION = {
  ...REPLACE_BASE,
  citationId: "citation-1",
};

describe("zod object strip semantics (forward-compat contract)", () => {
  // Every schema in this file (with the deliberate exception of
  // `SaveDialogOptionsSchema` which is `.strict()`) relies on zod's
  // default `.strip()` behaviour so a future renderer release can add a
  // new field to e.g. `CreateTaskRequest` and the old main process
  // silently drops it instead of throwing. Pinning this contract in a
  // test means a future zod upgrade (or accidental `.strict()`) that
  // flips the default will fail loudly here.
  it("strips unknown keys from CreateTaskSchema by default", () => {
    const parsed = CreateTaskSchema.parse({
      title: "x",
      fromFutureRelease: "ignore me",
    });
    expect(parsed).toEqual({ title: "x" });
    expect("fromFutureRelease" in parsed).toBe(false);
  });

  it("strips unknown keys from SettingsUpdateSchema by default", () => {
    const parsed = SettingsUpdateSchema.parse({
      theme: "dark",
      newFutureField: 123,
    });
    expect(parsed).toEqual({ theme: "dark" });
  });
});

describe("AddCitationSchema", () => {
  it("accepts a full valid payload", () => {
    expect(AddCitationSchema.parse(VALID_ADD_CITATION)).toEqual(
      VALID_ADD_CITATION,
    );
  });

  it("accepts a numeric page", () => {
    const parsed = AddCitationSchema.parse({ ...VALID_ADD_CITATION, page: 3 });
    expect(parsed.page).toBe(3);
  });

  it("rejects missing required fields", () => {
    const { artifactId: _ignored, ...rest } = VALID_ADD_CITATION;
    expect(() => AddCitationSchema.parse(rest)).toThrow();
  });

  it("rejects empty artifactId", () => {
    expect(() =>
      AddCitationSchema.parse({ ...VALID_ADD_CITATION, artifactId: "" }),
    ).toThrow();
  });

  it("rejects confidence outside [0, 1]", () => {
    expect(() =>
      AddCitationSchema.parse({ ...VALID_ADD_CITATION, confidence: 1.5 }),
    ).toThrow();
    expect(() =>
      AddCitationSchema.parse({ ...VALID_ADD_CITATION, confidence: -0.1 }),
    ).toThrow();
  });

  it("rejects a non-integer page", () => {
    expect(() =>
      AddCitationSchema.parse({ ...VALID_ADD_CITATION, page: 3.5 }),
    ).toThrow();
  });
});

describe("ReplaceCitationSchema", () => {
  it("accepts a full valid payload", () => {
    expect(ReplaceCitationSchema.parse(VALID_REPLACE_CITATION)).toEqual(
      VALID_REPLACE_CITATION,
    );
  });

  it("rejects missing citationId", () => {
    const { citationId: _ignored, ...rest } = VALID_REPLACE_CITATION;
    expect(() => ReplaceCitationSchema.parse(rest)).toThrow();
  });
});

describe("CreateTaskSchema", () => {
  it("accepts the minimal payload", () => {
    const parsed = CreateTaskSchema.parse({ title: "Buy milk" });
    expect(parsed.title).toBe("Buy milk");
  });

  it("rejects empty title", () => {
    expect(() => CreateTaskSchema.parse({ title: "" })).toThrow();
  });

  it("rejects an unknown status", () => {
    expect(() =>
      CreateTaskSchema.parse({ title: "x", status: "wat" }),
    ).toThrow();
  });

  it("accepts a null assignee (explicit clear)", () => {
    const parsed = CreateTaskSchema.parse({ title: "x", assignee: null });
    expect(parsed.assignee).toBeNull();
  });

  it.each(TASK_STATUSES)("accepts every canonical TaskStatus: %s", (s) => {
    const parsed = CreateTaskSchema.parse({ title: "t", status: s });
    expect(parsed.status).toBe(s);
  });

  it.each(TASK_PRIORITIES)(
    "accepts every canonical TaskPriority: %s",
    (p) => {
      const parsed = CreateTaskSchema.parse({ title: "t", priority: p });
      expect(parsed.priority).toBe(p);
    },
  );
});

describe("UpdateTaskSchema", () => {
  it("accepts a fully empty patch", () => {
    expect(UpdateTaskSchema.parse({})).toEqual({});
  });

  it("preserves the tri-state assignee semantics", () => {
    expect(UpdateTaskSchema.parse({ assignee: "alice" }).assignee).toBe(
      "alice",
    );
    expect(UpdateTaskSchema.parse({ assignee: null }).assignee).toBeNull();
    expect(UpdateTaskSchema.parse({}).assignee).toBeUndefined();
  });

  it("rejects a negative position", () => {
    expect(() => UpdateTaskSchema.parse({ position: -1 })).toThrow();
  });

  it("rejects an empty title (blank Kanban card guard)", () => {
    expect(() => UpdateTaskSchema.parse({ title: "" })).toThrow();
  });

  it("accepts a non-empty title rename", () => {
    expect(UpdateTaskSchema.parse({ title: "renamed" }).title).toBe("renamed");
  });

  it("still allows an empty description (deliberate clear)", () => {
    expect(UpdateTaskSchema.parse({ description: "" }).description).toBe("");
  });
});

describe("AutomationTriggerSchema", () => {
  it("accepts a schedule trigger", () => {
    const parsed = AutomationTriggerSchema.parse({
      kind: "schedule",
      interval_seconds: 3600,
    });
    expect(parsed.kind).toBe("schedule");
  });

  it("accepts an on_generate trigger", () => {
    const parsed = AutomationTriggerSchema.parse({
      kind: "on_generate",
      template_id: "tmpl-1",
    });
    expect(parsed.kind).toBe("on_generate");
  });

  it("rejects an unknown trigger kind", () => {
    expect(() =>
      AutomationTriggerSchema.parse({ kind: "bogus" }),
    ).toThrow();
  });

  it("rejects schedule with interval_seconds < 1", () => {
    expect(() =>
      AutomationTriggerSchema.parse({ kind: "schedule", interval_seconds: 0 }),
    ).toThrow();
  });
});

describe("AutomationActionSchema", () => {
  it("accepts a reindex_source action", () => {
    const parsed = AutomationActionSchema.parse({
      kind: "reindex_source",
      source_id: "src-1",
    });
    expect(parsed.kind).toBe("reindex_source");
  });

  it("accepts a generate_from_template action", () => {
    const parsed = AutomationActionSchema.parse({
      kind: "generate_from_template",
      template_id: "tmpl-1",
      source_ids: ["src-1", "src-2"],
    });
    expect(parsed.kind).toBe("generate_from_template");
  });

  it("rejects an unknown action kind", () => {
    expect(() =>
      AutomationActionSchema.parse({ kind: "bogus" }),
    ).toThrow();
  });
});

describe("CreateAutomationSchema", () => {
  it("accepts a well-formed automation", () => {
    const parsed = CreateAutomationSchema.parse({
      name: "auto-1",
      trigger: { kind: "schedule", interval_seconds: 60 },
      action: { kind: "reindex_source", source_id: "s-1" },
    });
    expect(parsed.name).toBe("auto-1");
  });

  it("rejects empty name", () => {
    expect(() =>
      CreateAutomationSchema.parse({
        name: "",
        trigger: { kind: "schedule", interval_seconds: 60 },
        action: { kind: "reindex_source", source_id: "s-1" },
      }),
    ).toThrow();
  });

  it("rejects non-object trigger", () => {
    expect(() =>
      CreateAutomationSchema.parse({
        name: "auto-1",
        trigger: "wat",
        action: { kind: "reindex_source", source_id: "s-1" },
      }),
    ).toThrow();
  });
});

describe("SettingsUpdateSchema", () => {
  it("accepts a partial settings update", () => {
    expect(SettingsUpdateSchema.parse({ theme: "dark" })).toEqual({
      theme: "dark",
    });
  });

  it("rejects an unknown theme", () => {
    expect(() => SettingsUpdateSchema.parse({ theme: "neon" })).toThrow();
  });

  it("rejects an oversized ignorePatterns array", () => {
    const arr = Array.from({ length: 10_001 }, (_, i) => `pat-${i}`);
    expect(() =>
      SettingsUpdateSchema.parse({ ignorePatterns: arr }),
    ).toThrow();
  });

  it.each(THEMES)("accepts every canonical Theme: %s", (t) => {
    const parsed = SettingsUpdateSchema.parse({ theme: t });
    expect(parsed.theme).toBe(t);
  });

  it.each(EXPORT_FORMATS)(
    "accepts every canonical ExportFormat: %s",
    (f) => {
      const parsed = SettingsUpdateSchema.parse({ defaultExportFormat: f });
      expect(parsed.defaultExportFormat).toBe(f);
    },
  );
});

const VALID_PROVIDER = {
  enabled: true,
  providerType: "openai_compatible" as const,
  apiUrl: "https://api.openai.com",
  apiKeyRef: "openai-prod",
  modelName: "gpt-4o-mini",
  maxTokens: 4096,
  temperature: 0.7,
  timeoutSecs: 30,
  maxRetries: 2,
};

describe("ExternalProviderConfigSchema", () => {
  it("accepts a full valid payload", () => {
    expect(ExternalProviderConfigSchema.parse(VALID_PROVIDER)).toEqual(
      VALID_PROVIDER,
    );
  });

  it("rejects unknown providerType", () => {
    expect(() =>
      ExternalProviderConfigSchema.parse({
        ...VALID_PROVIDER,
        providerType: "bogus",
      }),
    ).toThrow();
  });

  it("rejects temperature outside [0, 2]", () => {
    expect(() =>
      ExternalProviderConfigSchema.parse({
        ...VALID_PROVIDER,
        temperature: 3,
      }),
    ).toThrow();
  });

  it("rejects timeoutSecs < 1", () => {
    expect(() =>
      ExternalProviderConfigSchema.parse({
        ...VALID_PROVIDER,
        timeoutSecs: 0,
      }),
    ).toThrow();
  });
});

describe("GenerateRequestSchema", () => {
  it("accepts the minimal payload", () => {
    expect(GenerateRequestSchema.parse({ prompt: "Summarise this" })).toEqual({
      prompt: "Summarise this",
    });
  });

  it("rejects empty prompt", () => {
    expect(() => GenerateRequestSchema.parse({ prompt: "" })).toThrow();
  });

  it("rejects negative maxTokens", () => {
    expect(() =>
      GenerateRequestSchema.parse({ prompt: "x", maxTokens: -1 }),
    ).toThrow();
  });
});

describe("TypstExportSchema", () => {
  it("accepts a pdf export", () => {
    const parsed = TypstExportSchema.parse({
      markup: "= Title\nbody",
      format: "pdf",
    });
    expect(parsed.format).toBe("pdf");
  });

  it("rejects an unknown format", () => {
    expect(() =>
      TypstExportSchema.parse({ markup: "x", format: "docx" }),
    ).toThrow();
  });
});

describe("MarpExportSchema", () => {
  it("accepts a valid payload", () => {
    const parsed = MarpExportSchema.parse({
      markdown: "# slide",
      format: "pdf",
      outputPath: "slides.pdf",
    });
    expect(parsed.format).toBe("pdf");
  });

  it("rejects an unknown format", () => {
    expect(() =>
      MarpExportSchema.parse({
        markdown: "# slide",
        format: "key",
        outputPath: "x",
      }),
    ).toThrow();
  });
});

describe("GdriveSelectedItemsSchema", () => {
  it("accepts an array of items", () => {
    const items = [
      { id: "1", name: "a", mimeType: "text/plain" },
      { id: "2", name: "b", mimeType: "application/pdf" },
    ];
    expect(GdriveSelectedItemsSchema.parse(items)).toEqual(items);
  });

  it("rejects non-array input", () => {
    expect(() => GdriveSelectedItemsSchema.parse({})).toThrow();
  });

  it("rejects items missing id", () => {
    expect(() =>
      GdriveSelectedItemsSchema.parse([{ name: "a", mimeType: "x" }]),
    ).toThrow();
  });

  // Empty `id` is its own failure mode: the field is present (so the
  // "missing id" path above doesn't catch it) but a downstream Drive
  // API call with `fileId=""` produces a 404 the user can't act on.
  // The schema enforces `NonEmptyString` at the IPC boundary so the
  // renderer's drive picker bug surfaces here, not 2 hops downstream.
  it("rejects items with an empty-string id", () => {
    expect(() =>
      GdriveSelectedItemsSchema.parse([
        { id: "", name: "a", mimeType: "text/plain" },
      ]),
    ).toThrow();
  });

  it("rejects items with an over-long id", () => {
    expect(() =>
      GdriveSelectedItemsSchema.parse([
        { id: "x".repeat(513), name: "a", mimeType: "text/plain" },
      ]),
    ).toThrow();
  });
});

describe("SaveDialogOptionsSchema", () => {
  it("accepts a full valid payload", () => {
    const opts = {
      title: "Save report",
      defaultPath: "/tmp/report.pdf",
      buttonLabel: "Export",
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    };
    expect(SaveDialogOptionsSchema.parse(opts)).toEqual(opts);
  });

  it("accepts an empty object (all fields optional)", () => {
    expect(SaveDialogOptionsSchema.parse({})).toEqual({});
  });

  it("rejects unknown keys (strict mode)", () => {
    expect(() =>
      SaveDialogOptionsSchema.parse({ title: "x", bogus: true }),
    ).toThrow();
  });

  it("rejects a title exceeding 512 chars", () => {
    expect(() =>
      SaveDialogOptionsSchema.parse({ title: "x".repeat(513) }),
    ).toThrow();
  });
});
