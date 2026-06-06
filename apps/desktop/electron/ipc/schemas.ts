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
  APP_LOCK_MODES,
  EXPORT_FORMATS,
  EXTERNAL_PROVIDER_TYPES,
  MAX_MODEL_IDLE_TIMEOUT_SECS,
  MAX_PINNED_ARTIFACTS,
  MAX_RECENT_ARTIFACTS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  THEMES,
  type AutomationAction,
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
  // Dependency task ids (UUID strings). The bridge validates each id
  // parses as a UUID and rejects dependency cycles; here we only bound
  // the shape so a malformed payload can't reach the bridge.
  dependsOn: z.array(NonEmptyString).max(10_000).optional(),
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
  // `undefined` leaves dependencies unchanged; an array replaces the
  // set (`[]` clears). The bridge rejects cycles.
  dependsOn: z.array(NonEmptyString).max(10_000).optional(),
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
  z.object({
    kind: z.literal("on_kchat_message_match"),
    channel_id: NonEmptyString,
    // Regex source string; the bridge compiles it (and rejects an
    // invalid pattern) — we only bound the length here.
    regex: NonEmptyString,
  }),
]);

// `AutomationAction` is recursive: a `sequence` wraps an ordered list
// of sub-actions (themselves possibly sequences). The leaf variants
// validate by their `kind` discriminator.
const ReindexSourceActionSchema = z.object({
  kind: z.literal("reindex_source"),
  source_id: NonEmptyString,
});
const GenerateFromTemplateActionSchema = z.object({
  kind: z.literal("generate_from_template"),
  template_id: NonEmptyString,
  source_ids: z.array(NonEmptyString).max(10_000),
});

// Maximum `sequence` nesting depth. A naive `z.lazy` recursion has no
// depth bound, so a payload nested a few thousand levels deep
// (`{sequence:[{sequence:[…]}]}`) overflows the call stack *during
// validation* and crashes the main process — the `.max()` breadth cap
// does not constrain depth. Instead we build a finite, depth-bounded
// schema: at depth 0 a `sequence` is no longer an accepted variant, so
// an over-deep payload fails the discriminator with a normal zod error
// rather than recursing unboundedly. Kept well under serde_json's
// default 128-deep recursion limit on the Rust side, so anything the
// IPC layer accepts the bridge can also deserialize. Real automations
// nest only a handful of levels.
const MAX_ACTION_DEPTH = 32;

function buildActionSchema(depth: number): z.ZodType<AutomationAction> {
  if (depth <= 0) {
    return z.discriminatedUnion("kind", [
      ReindexSourceActionSchema,
      GenerateFromTemplateActionSchema,
    ]) as z.ZodType<AutomationAction>;
  }
  return z.discriminatedUnion("kind", [
    ReindexSourceActionSchema,
    GenerateFromTemplateActionSchema,
    z.object({
      kind: z.literal("sequence"),
      actions: z.array(buildActionSchema(depth - 1)).max(1_000),
    }),
  ]) as z.ZodType<AutomationAction>;
}

export const AutomationActionSchema: z.ZodType<AutomationAction> =
  buildActionSchema(MAX_ACTION_DEPTH);

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
  // first-run onboarding flag. Renderer-writable so
  // the wizard's "Finish" / "Skip" buttons can flip it to `true`. No
  // `.catch()` because a renderer-side type narrowing failure would
  // be a renderer bug worth surfacing rather than silently coercing.
  onboardingCompleted: z.boolean().optional(),
  // pinned/favorited artifact IDs. Cap pulled
  // from `MAX_PINNED_ARTIFACTS` in `shared/types.ts` (single source
  // of truth shared with `AppConfigSchema.pinnedArtifactIds.max()`
  // and the renderer's `usePinnedArtifacts.MAX_PINNED_ARTIFACTS`).
  // PR #87: previously a literal `256`
  // that risked drift across three files. Element max length
  // matches the artifact ID bound used everywhere else (`assertId`
  // enforces ≤ 1024).
  pinnedArtifactIds: z
    .array(z.string().max(1024))
    .max(MAX_PINNED_ARTIFACTS)
    .optional(),
  // view-recency list. Cap pulled from
  // `MAX_RECENT_ARTIFACTS` in `shared/types.ts` (single source of
  // truth shared with `AppConfigSchema.recentArtifactIds.max()`).
  // requirement. Element max length matches the artifact ID bound
  // used everywhere else (`assertId` enforces ≤ 1024).
  recentArtifactIds: z
    .array(z.string().max(1024))
    .max(MAX_RECENT_ARTIFACTS)
    .optional(),
  // idle-unload window in seconds for the
  // local sidecars. `0` disables idle unloading entirely ("Keep
  // loaded forever"). The upper bound is shared with
  // `MAX_MODEL_IDLE_TIMEOUT_SECS` in `shared/types.ts` (24 h) so
  // the IPC schema, on-disk schema, and `SettingsPage` validator
  // stay in lockstep. No `.catch()` (matches sibling fields
  // above): the renderer's `<select>` only emits values from a
  // bounded set, so any out-of-range value here means the renderer
  // shipped a bug worth surfacing rather than silently coercing.
  modelIdleTimeoutSecs: z
    .number()
    .int()
    .min(0)
    .max(MAX_MODEL_IDLE_TIMEOUT_SECS)
    .optional(),
  // local telemetry toggle. Pure boolean
  // toggle; the handler in `ipc/settings.ts` is responsible for
  // calling `enableTelemetry()` / `disableTelemetry()` on the
  // singleton sink when this transitions.
  telemetryEnabled: z.boolean().optional(),
  // app-lock mode. Pure enum here; the
  // handler enforces "must have set a PIN before switching to
  // `pin` / `biometric`" so the IPC cannot transition the user
  // into a state where they cannot unlock the app on next launch.
  appLockMode: z.enum(APP_LOCK_MODES).optional(),
  // auto-updater Ed25519 enforcement. The
  // handler logs the transition because flipping this to `false`
  // is a privileged action that materially reduces install
  // security.
  enforceUpdateSignature: z.boolean().optional(),
  // Per-app keychain ACL enforcement. The handler logs the transition
  // because flipping this to `false` on Linux materially weakens the
  // at-rest protection of secrets (basic_text fallback =
  // XOR-with-hardcoded-key). macOS / Windows installs are unaffected
  // by the value.
  enforceKeychainAcl: z.boolean().optional(),
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

// The `externalProvider:set` handler accepts a second argument carrying
// the raw API key, separate from the `ExternalProviderConfigInput`
// payload (the config stores only an `apiKeyRef`; the secret itself
// lives in the OS keychain via `secretsVault`). Tri-state semantics:
//
//   string (non-empty)  -> store this secret under `apiKeyRef`
//   ""                  -> explicitly forget the stored secret
//   null                -> leave whatever is in the keychain alone
//
// Bounded at `MAX_STRING_LEN` so a compromised renderer cannot push
// arbitrarily large payloads into the OS keychain (which has its own
// platform-dependent size limits and would either reject or silently
// truncate without validation).
export const ExternalProviderApiKeySchema = z
  .string()
  .max(MAX_STRING_LEN)
  .nullable();
export type ExternalProviderApiKeyInput = z.infer<
  typeof ExternalProviderApiKeySchema
>;

// --- Hybrid search config update ---
// Matches `HybridSearchConfigUpdate` in `apps/desktop/shared/types.ts`
// and is forwarded into `tessera_bridge::sources::HybridSearchConfigUpdate`
// on the Rust side. Every field is optional — undefined fields keep
// their current value, while explicit values are validated against
// the same bounds the Rust `HybridSearchConfig::apply_patch` validator
// enforces so we can return a structured error inline at the IPC layer
// rather than relying on bridge errors leaking through.
//
// Bounds are deliberately tighter than the Rust validator (which only
// rejects negative/NaN/Infinity weights and zero/negative halflives):
// the renderer's slider can only ever produce values in these ranges,
// so anything outside is a sign of a renderer bug or a tampering
// attempt rather than a configuration choice we should honour.
/**
 * slugs the renderer is allowed to ask the bridge
 * to download / switch to. Must stay in lock-step with
 * `crates/tessera_sources/src/model_registry.rs::SHIPPED_MODELS`.
 *
 * Keeping the enum here (not in Rust) is a deliberate defense-in-
 * depth choice: a compromised renderer that bypasses the picker
 * UI and crafts a `settings:downloadEmbeddingModel` IPC payload
 * cannot point the bridge at an arbitrary HTTP URL — the IPC layer
 * rejects unknown slugs at the zod boundary before the bridge ever
 * sees the value. The Rust side ALSO validates against the
 * registry as a second line of defense (`lookup(slug)?`), so even
 * a renderer that imported a stale schema would fail closed.
 */
export const EmbeddingModelSlugSchema = z.enum([
  "all-MiniLM-L6-v2",
  "paraphrase-multilingual-MiniLM-L12-v2",
  // reserved pseudo-slug that maps to the bundled
  // offline HashTrick provider on the Rust side. No download path
  // — `settings:downloadEmbeddingModel` rejects this slug. See
  // `crates/tessera_bridge/src/sources.rs::HASH_TRICK_SLUG`.
  "hash-trick",
]);
export type EmbeddingModelSlug = z.infer<typeof EmbeddingModelSlugSchema>;

/**
 * download-only subset of the slug enum. The
 * `hash-trick` slug is omitted here because it has no on-disk
 * artefact and downloading it makes no sense — calling
 * `settings:downloadEmbeddingModel` with it must fail closed at
 * the IPC boundary rather than reach the bridge with a no-op.
 */
export const DownloadableEmbeddingModelSlugSchema = z.enum([
  "all-MiniLM-L6-v2",
  "paraphrase-multilingual-MiniLM-L12-v2",
]);
export type DownloadableEmbeddingModelSlug = z.infer<
  typeof DownloadableEmbeddingModelSlugSchema
>;

export const DownloadableEmbeddingModelSlugInputSchema = z
  .object({
    slug: DownloadableEmbeddingModelSlugSchema,
  })
  .strict();

export const EmbeddingModelSlugInputSchema = z
  .object({
    slug: EmbeddingModelSlugSchema,
  })
  .strict();

export const HybridSearchConfigUpdateSchema = z
  .object({
    bm25Weight: z.number().finite().min(0).max(10).optional(),
    vectorWeight: z.number().finite().min(0).max(10).optional(),
    rrfK: z.number().finite().min(0.0001).max(1_000).optional(),
    recencyDecayEnabled: z.boolean().optional(),
    recencyHalflifeSecs: z
      .number()
      .finite()
      .min(1)
      .max(10 * 365 * 24 * 60 * 60)
      .optional(),
    candidatePoolSize: z.number().int().min(0).max(10_000).optional(),
  })
  // Use `.strict()` rather than the default `.strip()` so a renderer
  // bug or compromised IPC caller that sends a field the schema
  // doesn't know about gets a hard error. The Rust bridge has its own
  // strict serde-based validator one level down (`HybridSearchConfigUpdate`
  // would reject unknown fields if `serde(deny_unknown_fields)` were
  // set, but it isn't — napi-derive doesn't expose that knob). Strict
  // mode here closes that gap.
  .strict();
export type HybridSearchConfigUpdateInput = z.infer<
  typeof HybridSearchConfigUpdateSchema
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
  // Per-request override cap (32k tokens) is deliberately tighter
  // than `ExternalProviderConfigSchema.maxTokens` (1M). Rationale:
  //
  //   * The provider-level cap protects the on-disk config from
  //     accidental garbage (a renderer bug that writes
  //     `Number.MAX_SAFE_INTEGER` shouldn't be silently persisted).
  //     1M is the documented hard ceiling for several
  //     frontier-model context windows today.
  //   * The per-request cap is a runtime budget guard — the
  //     `model:generate` IPC is what a single user keystroke can
  //     fire, and 32k tokens is more than enough headroom for any
  //     single rendered section (`sectionIndex` above) while making
  //     it structurally impossible for a stale renderer state to
  //     burn down an entire 1M-token provider budget in one call.
  //
  // The effective limit applied by `buildStreamRequest` is
  // `inputs.maxTokens ?? provider.maxTokens`, so per-request
  // omission silently falls through to the provider cap — that path
  // is reserved for explicit "use my configured ceiling" semantics
  // and the renderer never hits it via the `maxTokens` slider.
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
//
// `id` uses `NonEmptyString` because every downstream consumer
// (`connectors:gdriveImportSelected` -> `bridge.gdriveImportSelected`)
// treats it as the canonical Google Drive file ID and would emit a
// confusing 404 from the Drive API if it were empty. `name` and
// `mimeType` keep the looser `string` because Drive permits unicode
// names and the bridge sanitises them downstream.
export const GdriveSelectedItemsSchema = z
  .array(
    z.object({
      id: NonEmptyString.max(512),
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
//
// This is one of the few schemas in this file that uses `.strict()`
// instead of the default `.strip()`. Most schemas strip unknown keys
// so a newer renderer can send forward-compat fields the older main
// process doesn't know about without crashing; the Rust bridge's
// serde layer rejects unknown fields downstream so stripping is safe.
//
// The `.strict()` schemas in this file are payloads that flow
// directly into platform-specific native APIs where unknown fields
// could trigger provider-specific side effects we don't want a
// renderer bug accidentally enabling:
//
//   - `SaveDialogOptionsSchema` (this one) — Electron's native dialog
//     API (Cocoa / Win32 / GTK).
//   - `VisionDescribeSchema` — vision sidecar (`llama-server
//     --mmproj`) which forwards every JSON key to llama.cpp.
//   - `GenerateImageSchema` — diffusion sidecar (`sd-server`) which
//     forwards every JSON key to stable-diffusion.cpp.
//
// If you add a new field to `SaveDialogOptions` in `shared/types.ts`,
// extend this schema in the same commit — strict mode will reject
// the new field otherwise.
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

// --- Open image dialog ---
//
// `dialog:pickImage` is the renderer-side entry point for the Vision
// page — it opens an OS file picker locked to image extensions and
// returns the absolute path of the chosen file (or null if the user
// cancelled). The handler intentionally does NOT load the file or
// pre-encode it — the renderer never needs the bytes, only the path,
// which it forwards to `vision:describe` for OCR / describe / chart.
//
// Strict-mode schema for the same reasons as `SaveDialogOptionsSchema`:
// the payload flows straight into Electron's native open-dialog APIs
// (Cocoa / Win32 / GTK) and unknown fields could trigger provider-
// specific side effects.
//
// `title` is the dialog window title shown to the user. We bound it
// the same way as the save dialog (512 chars) because the OS layer
// rejects very long titles inconsistently across platforms.
export const OpenImageDialogSchema = z
  .object({
    title: z.string().max(512).optional(),
  })
  .strict();
export type OpenImageDialogInput = z.infer<typeof OpenImageDialogSchema>;

// --- Vision describe ---
//
// `vision:describe` accepts an absolute path to an image already on
// the user's disk plus the prompt mode (describe/ocr/chart). The
// path bound matches the OS PATH_MAX upper bound (Linux 4096 is the
// largest of the common platforms — macOS 1024, Windows 32 767 only
// applies with extended-length prefixes). The renderer is expected
// to validate that the path is an image before calling, but the
// Rust side ALSO reads the file extension defensively, so a non-
// image will fail loudly downstream rather than silently corrupting
// the search index with a hallucinated VLM description of random
// bytes.
export const VisionDescribeSchema = z
  .object({
    imagePath: z.string().min(1).max(4096),
    mode: z.enum(["describe", "ocr", "chart"]),
    // Vision completions are deliberately bounded tighter than text
    // completions: an OCR/describe/chart prompt should never need
    // more than ~2k tokens of output. Anything longer means the VLM
    // is rambling and the result is unlikely to be useful for the
    // search index.
    maxTokens: z.number().int().min(16).max(2048).optional(),
  })
  .strict();
export type VisionDescribeInput = z.infer<typeof VisionDescribeSchema>;

// --- Image generation ---
//
// Tight bounds on every diffusion sampling knob:
//   * `width` / `height`: limited to a 256-2048 pixel range. FLUX.2-
//     klein is trained at 1024×1024 — sub-256 produces visible
//     compression artifacts and the model wasn't trained at those
//     scales; above 2048 OOMs all but the largest consumer GPUs
//     and the renderer hides those options anyway.
//   * `width` / `height` must be multiples of 64 — diffusion VAEs
//     downsample by 8x and the UNet downsamples by 2x more, so any
//     dimension not divisible by 64 produces ragged latent
//     dimensions and silent quality degradation.
//   * `steps`: 1-100. FLUX.2-klein needs ~20 by design; the bound
//     just catches obviously-bad values from a renderer bug.
//   * `cfgScale`: 0-15. FLUX uses ~3.5 and absolutely does not
//     benefit from CFG > 15 (which produces oversaturated, melted
//     compositions on SD-style models).
//   * `seed`: non-negative integer < 2^53 so it survives JSON
//     round-trip via Number (the bridge converts to u64 inside the
//     Rust task).
//   * `prompt` / `negativePrompt`: bounded at 4 KiB to defend
//     against renderer bugs sending entire artifact bodies as
//     prompts; FLUX text encoders only see the first ~512 tokens
//     anyway, so 4 KiB is generous headroom.
const DimensionBound = z
  .number()
  .int()
  .min(256)
  .max(2048)
  .refine((n) => n % 64 === 0, {
    message: "must be a multiple of 64 (diffusion-VAE alignment)",
  });

export const GenerateImageSchema = z
  .object({
    prompt: z.string().min(1).max(4096),
    width: DimensionBound,
    height: DimensionBound,
    steps: z.number().int().min(1).max(100).optional(),
    cfgScale: z.number().finite().min(0).max(15).optional(),
    // JSON Number can express integers up to 2^53 - 1 without loss;
    // values beyond that would silently round-trip incorrectly.
    seed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    negativePrompt: z.string().max(4096).optional(),
    // Identifier used to namespace the on-disk output under
    // `<userData>/generated-images/<artifactId>/`. Validated as an
    // id (alphanum + dash) by the handler itself; this schema just
    // shapes it.
    artifactId: z.string().min(1).max(256),
    sectionIndex: z.number().int().min(0).max(1000).optional(),
  })
  .strict();
export type GenerateImageInput = z.infer<typeof GenerateImageSchema>;
