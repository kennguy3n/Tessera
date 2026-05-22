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
} from "../ipc/schemas";

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
});

describe("CreateAutomationSchema", () => {
  it("accepts well-formed trigger/action objects", () => {
    const parsed = CreateAutomationSchema.parse({
      name: "auto-1",
      trigger: { kind: "interval", every_secs: 60 },
      action: { kind: "run_template", template_id: "t-1" },
    });
    expect(parsed.name).toBe("auto-1");
  });

  it("rejects empty name", () => {
    expect(() =>
      CreateAutomationSchema.parse({ name: "", trigger: {}, action: {} }),
    ).toThrow();
  });

  it("rejects non-object trigger", () => {
    expect(() =>
      CreateAutomationSchema.parse({
        name: "auto-1",
        trigger: "wat",
        action: {},
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
});
