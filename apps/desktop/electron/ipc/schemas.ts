/**
 * Zod schemas for IPC handler input validation.
 *
 * Every IPC handler that accepts a structured object from the renderer
 * runs the raw payload through one of these schemas before forwarding
 * to the Rust bridge. The simple scalar validators in
 * `./validate.ts` (assertString, assertId, assertUuid,
 * assertProvider, …) cover single-value channels; schemas in this file
 * cover the complex object payloads (CreateTaskRequest,
 * UpdateTaskRequest, AddCitationRequest, ReplaceCitationRequest,
 * CreateAutomationRequest, ExternalProviderConfigInput, GenerateRequest,
 * etc.).
 *
 * The schemas mirror the shapes already documented in
 * `apps/desktop/shared/types.ts` — they are NOT a second source of
 * truth for the wire format, just an enforcement layer that rejects
 * malformed payloads at the IPC boundary so the Rust bridge never sees
 * shape violations.
 */
import { z } from "zod";

/** Hard upper bound shared with `./validate.ts:DEFAULT_MAX_STRING_LEN`. */
const MAX_STRING_LEN = 1_000_000;

const NonEmptyString = z.string().min(1).max(MAX_STRING_LEN);
const OptionalString = z.string().max(MAX_STRING_LEN).optional();
const NullableString = z.string().max(MAX_STRING_LEN).nullable();

// --- Citations ---

export const AddCitationSchema = z.object({
  artifactId: NonEmptyString,
  sourceId: NonEmptyString,
  sourceType: NonEmptyString,
  sourceTitle: z.string().max(MAX_STRING_LEN),
  sourceUri: z.string().max(MAX_STRING_LEN),
  chunkHash: NonEmptyString,
  page: z.number().int().nullable(),
  confidence: z.number().min(0).max(1),
  usedFor: z.string().max(MAX_STRING_LEN),
});
export type AddCitationInput = z.infer<typeof AddCitationSchema>;

export const ReplaceCitationSchema = z.object({
  artifactId: NonEmptyString,
  citationId: NonEmptyString,
  sourceId: NonEmptyString,
  sourceType: NonEmptyString,
  sourceTitle: z.string().max(MAX_STRING_LEN),
  sourceUri: z.string().max(MAX_STRING_LEN),
  chunkHash: NonEmptyString,
  page: z.number().int().nullable(),
  confidence: z.number().min(0).max(1),
});
export type ReplaceCitationInput = z.infer<typeof ReplaceCitationSchema>;

// --- Tasks ---

const TaskStatus = z.enum(["todo", "in_progress", "done"]);
const TaskPriority = z.enum(["low", "medium", "high"]);

export const CreateTaskSchema = z.object({
  title: NonEmptyString,
  description: OptionalString,
  status: TaskStatus.optional(),
  priority: TaskPriority.optional(),
  assignee: NullableString.optional(),
  dueDate: NullableString.optional(),
  sourceId: NullableString.optional(),
  extractedItemId: NullableString.optional(),
});
export type CreateTaskInput = z.infer<typeof CreateTaskSchema>;

export const UpdateTaskSchema = z.object({
  title: OptionalString,
  description: OptionalString,
  status: TaskStatus.optional(),
  priority: TaskPriority.optional(),
  position: z.number().int().min(0).optional(),
  // Tri-state semantics preserved from the bridge:
  //   undefined  -> field unchanged
  //   null       -> explicit clear
  //   string     -> set
  assignee: NullableString.optional(),
  dueDate: NullableString.optional(),
});
export type UpdateTaskInput = z.infer<typeof UpdateTaskSchema>;

// --- Automations ---

export const CreateAutomationSchema = z.object({
  name: NonEmptyString,
  trigger: z.record(z.string(), z.unknown()),
  action: z.record(z.string(), z.unknown()),
  enabled: z.boolean().optional(),
});
export type CreateAutomationInput = z.infer<typeof CreateAutomationSchema>;

// --- Settings ---

const ExportFormat = z.enum(["markdown", "html", "pdf", "json", "docx"]);

export const SettingsUpdateSchema = z.object({
  theme: z.enum(["light", "dark", "system"]).optional(),
  defaultExportFormat: ExportFormat.optional(),
  ignorePatterns: z.array(z.string().max(1024)).max(10_000).optional(),
  watchPatterns: z.array(z.string().max(1024)).max(10_000).optional(),
});
export type SettingsUpdateInput = z.infer<typeof SettingsUpdateSchema>;

// --- External LLM provider ---
// Matches `ExternalProviderConfigInput` in `apps/desktop/shared/types.ts`
// and the on-disk `ExternalProviderConfig` in `electron/config.ts`.

const ExternalProviderType = z.enum(["openai_compatible", "anthropic", "custom"]);

export const ExternalProviderConfigSchema = z.object({
  enabled: z.boolean(),
  providerType: ExternalProviderType,
  apiUrl: z.string().max(2048),
  apiKeyRef: NonEmptyString,
  modelName: z.string().max(512),
  maxTokens: z.number().int().min(1).max(1_000_000),
  temperature: z.number().min(0).max(2),
  timeoutSecs: z.number().int().min(1).max(600),
  maxRetries: z.number().int().min(0).max(10),
});
export type ExternalProviderConfigInput = z.infer<
  typeof ExternalProviderConfigSchema
>;

// --- Model generation ---

export const GenerateRequestSchema = z.object({
  prompt: NonEmptyString,
  maxTokens: z.number().int().min(1).max(32_768).optional(),
  temperature: z.number().min(0).max(2).optional(),
});
export type GenerateRequestInput = z.infer<typeof GenerateRequestSchema>;

// --- Artifact exports ---

const TypstFormat = z.enum(["pdf", "svg"]);
const MarpFormat = z.enum(["pdf", "pptx", "html"]);

export const TypstExportSchema = z.object({
  markup: z.string().max(10_000_000),
  format: TypstFormat,
  outputPath: OptionalString,
});
export type TypstExportInput = z.infer<typeof TypstExportSchema>;

export const MarpExportSchema = z.object({
  markdown: z.string().max(10_000_000),
  format: MarpFormat,
  // Either an absolute path (used as-is) OR a suggested filename — in
  // which case we prompt with the native save dialog.
  outputPath: z.string().max(4096),
  theme: OptionalString,
  includeNotes: z.boolean().optional(),
  allowHtml: z.boolean().optional(),
});
export type MarpExportInput = z.infer<typeof MarpExportSchema>;

// --- Drive picker ---

export const GdriveSelectedItemsSchema = z
  .array(
    z.object({
      id: z.string().max(512),
      name: z.string().max(2048),
      mimeType: z.string().max(256),
    }),
  )
  .max(10_000);
export type GdriveSelectedItemsInput = z.infer<typeof GdriveSelectedItemsSchema>;
