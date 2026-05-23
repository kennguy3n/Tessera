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
  CitationApi,
  CitationFreshness,
  CitationInfo,
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
  IndexedFileInfo,
  IndexingProgressInfo,
  InstalledModelRecord,
  MarpExportRequest,
  ModelApi,
  ModelDownloadProgress,
  ModelFormat,
  ModelPlatform,
  ModelStatus,
  PlatformInfo,
  ReplaceCitationRequest,
  ReplaceCitationResult,
  ResolvedModel,
  RuntimeApi,
  SaveDialogOptions,
  SaveDialogResult,
  SchedulerStatus,
  SchedulerStatusInfo,
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
  }
}
