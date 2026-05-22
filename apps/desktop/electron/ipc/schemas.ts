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
import {
  EXPORT_FORMATS,
  EXTERNAL_PROVIDER_TYPES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  THEMES,
} from "../../shared/types";

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
//
// Enum values come from `shared/types.ts` (TASK_STATUSES /
// TASK_PRIORITIES const tuples) so the schema, the canonical type
// union, and the renderer's TasksPage Kanban columns + dropdowns can
// never drift. Adding a new column / priority is a one-line change in
// shared/types.ts.
const TaskStatus = z.enum(TASK_STATUSES);
const TaskPriority = z.enum(TASK_PRIORITIES);

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
  // `title` is `NonEmptyString.optional()` rather than `OptionalString`:
  // a task with an empty title would render as a blank Kanban card with
  // no recoverable label, so we reject the rename at the IPC boundary
  // instead of letting it through and depending on the bridge / UI to
  // catch it later. `undefined` (field unchanged) is still allowed.
  // `description` deliberately stays `OptionalString` — clearing a task
  // description to empty is a legitimate user action.
  title: NonEmptyString.optional(),
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
//
// `AutomationTrigger` and `AutomationAction` are tagged unions in
// `shared/types.ts`. The bridge's serde layer will reject malformed
// variants downstream, but catching the same shape errors at the IPC
// boundary gives the renderer a precise zod error path
// (`trigger.interval_seconds`) instead of a deep "failed to deserialize
// AutomationTrigger" from Rust — which is the whole point of this
// validation pass.
export const AutomationTriggerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("schedule"),
    interval_seconds: z.number().int().min(1).max(31_536_000),
  }),
  z.object({
    kind: z.literal("on_generate"),
    template_id: NonEmptyString,
  }),
]);

export const AutomationActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("reindex_source"),
    source_id: NonEmptyString,
  }),
  z.object({
    kind: z.literal("generate_from_template"),
    template_id: NonEmptyString,
    source_ids: z.array(NonEmptyString).max(10_000),
  }),
]);

export const CreateAutomationSchema = z.object({
  name: NonEmptyString,
  trigger: AutomationTriggerSchema,
  action: AutomationActionSchema,
  enabled: z.boolean().optional(),
});
export type CreateAutomationInput = z.infer<typeof CreateAutomationSchema>;

// --- Settings ---
//
// Mirrors `SettingsData` in `shared/types.ts`. THEMES and
// EXPORT_FORMATS are imported from there so the schema, the canonical
// type union, and the renderer's SettingsPage `<select>` options can
// never drift. The pre-split code accepted `Partial<SettingsData>`
// where both fields were typed as `string` — the new schema narrows
// to the documented union, which matches the renderer's actual
// behaviour (the dropdowns only ever emit values from these tuples).
const Theme = z.enum(THEMES);
const ExportFormat = z.enum(EXPORT_FORMATS);

export const SettingsUpdateSchema = z.object({
  theme: Theme.optional(),
  defaultExportFormat: ExportFormat.optional(),
  ignorePatterns: z.array(z.string().max(1024)).max(10_000).optional(),
  watchPatterns: z.array(z.string().max(1024)).max(10_000).optional(),
});
export type SettingsUpdateInput = z.infer<typeof SettingsUpdateSchema>;

// --- External LLM provider ---
// Matches `ExternalProviderConfigInput` in `apps/desktop/shared/types.ts`
// and the on-disk `ExternalProviderConfig` in `electron/config.ts`.

// Pulls from the same `EXTERNAL_PROVIDER_TYPES` tuple `shared/types.ts`
// uses for the `ExternalProviderType` compile-time union — adding a
// provider in `shared/types.ts` automatically extends this enum.
const ExternalProviderType = z.enum(EXTERNAL_PROVIDER_TYPES);

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
//
// Mirrors the canonical `GenerateRequest` in `shared/types.ts`. The
// `model:generate` handler only forwards `prompt` / `maxTokens` /
// `temperature` to the llama-server `/completion` endpoint today —
// `templateId`, `sourceIds`, and `sectionIndex` are renderer-side
// composition hints used to build the prompt — but we still validate
// them at the boundary so a renderer bug (e.g. passing
// `sectionIndex` as a string) surfaces as a precise zod error rather
// than being silently stripped here and re-emerging downstream when
// some future handler does start reading these fields.
export const GenerateRequestSchema = z.object({
  templateId: OptionalString,
  sourceIds: z.array(NonEmptyString).max(10_000).optional(),
  sectionIndex: z.number().int().min(0).max(1_000_000).optional(),
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

// --- Native save dialog ---
//
// `dialog:showSaveDialog` is a thin wrapper around Electron's native
// save dialog. The dialog itself can't write files, but a compromised
// renderer could still send pathological options (extremely long
// `defaultPath`, hundreds of filter entries, etc.). Validating here
// keeps the validation policy uniform across every IPC channel and
// gives the OS dialog APIs a clean payload to work with.
export const SaveDialogOptionsSchema = z
  .object({
    title: z.string().max(512).optional(),
    defaultPath: z.string().max(4096).optional(),
    buttonLabel: z.string().max(128).optional(),
    filters: z
      .array(
        z.object({
          name: z.string().max(128),
          extensions: z.array(z.string().max(32)).max(64),
        }),
      )
      .max(64)
      .optional(),
  })
  .strict();
export type SaveDialogOptionsInput = z.infer<typeof SaveDialogOptionsSchema>;
