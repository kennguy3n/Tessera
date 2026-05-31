/**
 * Renderer-side IPC type re-exports.
 *
 * Historically this file held its own copies of ~30 wire types that
 * also lived in `electron/preload.ts` and `electron/appState.ts`.
 * That triplicate copy is gone — the canonical declarations now live
 * in `apps/desktop/shared/types.ts`. This file:
 *
 *   1. Re-exports every shared type the renderer code reads from
 *      `@/types/ipc` so existing imports keep working.
 *   2. Augments the global `Window` with the `tessera` namespace; the
 *      augmentation must stay here because it depends on the renderer
 *      DOM lib and cannot live in a file shared with the main process.
 */

export {
  TASK_STATUSES,
  TASK_PRIORITIES,
  THEMES,
  EXPORT_FORMATS,
  MAX_RECENT_ARTIFACTS,
  MAX_PINNED_ARTIFACTS,
} from "../../../shared/types";

export type {
  AddCitationRequest,
  ArtifactApi,
  ArtifactInfo,
  ArtifactVersionInfo,
  AutomationAction,
  AutomationApi,
  AutomationInfo,
  AutomationTrigger,
  BackfillEmbeddingsResult,
  CitationApi,
  CitationFreshness,
  CitationInfo,
  CompareSourcesResult,
  ComparisonInfo,
  ComputeBackend,
  ConnectorApi,
  ConnectorFileInfo,
  ConnectorStatusInfo,
  CreateAutomationRequest,
  CreateTaskRequest,
  DeviceTier,
  DialogApi,
  DownloadPlan,
  DriveFileListResult,
  DrivePickerItem,
  DrivePickerSelection,
  DriveSyncResult,
  EmbeddingProgressInfo,
  ExportResult,
  ExternalProviderApi,
  ExternalProviderConfigInput,
  ExternalProviderConfigView,
  ExternalProviderListModelsResult,
  ExternalProviderTestResult,
  ExternalProviderTokenUsage,
  ExternalProviderType,
  ExtractedItem,
  ExportFormat,
  GenerateChunk,
  GenerateRequest,
  EmbeddingDownloadProgressInfo,
  EmbeddingModelInfo,
  EmbeddingModelStatusInfo,
  HybridSearchConfigInfo,
  HybridSearchConfigUpdate,
  IndexedFileInfo,
  IndexingProgressInfo,
  KchatBackfillProgressView,
  InstalledModelRecord,
  MarpExportRequest,
  ModelApi,
  ModelCapability,
  ModelDownloadProgress,
  ModelFormat,
  ModelPlatform,
  ModelStatus,
  OpenImageDialogOptions,
  OpenImageDialogResult,
  PlatformInfo,
  ReplaceCitationRequest,
  ReplaceCitationResult,
  ResolvedModel,
  RuntimeApi,
  SaveDialogOptions,
  SaveDialogResult,
  SchedulerStatus,
  SchedulerStatusInfo,
  KchatPostSearchHit,
  SearchHit,
  SearchHitInfo,
  SettingsApi,
  SettingsData,
  SourceApi,
  SourceDetailInfo,
  SourceInfo,
  TaskApi,
  TaskInfo,
  TaskPriority,
  TaskStatus,
  Theme,
  ThemeInfo,
  TemplateApi,
  TemplateInfo,
  TesseraApi,
  TypstExportRequest,
  TypstExportResult,
  UpdatesApi,
  UpdateStatusInfo,
  UpdateTaskRequest,
} from "../../../shared/types";

import type { TesseraApi } from "../../../shared/types";

declare global {
  interface Window {
    tessera: TesseraApi;
    /**
     * Phase 15 Task 25 — per-session CSP nonce exposed by
     * `preload.ts`. Components that emit a `<style>{…}</style>`
     * block read this and pass it as the `nonce` attribute so the
     * strict `style-src-elem 'self' 'nonce-X'` directive accepts
     * the inline stylesheet. May be the empty string in test
     * harnesses where the preload script is mocked — components
     * should pass it unconditionally; an empty nonce simply fails
     * the CSP check at runtime, which is the loud failure we want
     * if a renderer bundle ever loads without the matching nonce.
     */
    tesseraCspNonce: string;
  }
}
