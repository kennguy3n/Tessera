/**
 * AUTO-GENERATED — DO NOT EDIT BY HAND.
 *
 * Generated from `apps/desktop/electron/ipc/schemas.ts` by
 * `apps/desktop/scripts/generate-ipc-types.mjs`.
 *
 * Regenerate with:  npm run generate:ipc-types --workspace=apps/desktop
 * CI fails (see the "Check generated IPC types" step) if this file is
 * out of date relative to the zod schemas.
 */

export type AddCitationInput = {
  artifactId: string;
  sourceId: string;
  sourceType: string;
  sourceTitle: string;
  sourceUri: string;
  chunkHash: string;
  page: number | null;
  confidence: number;
  usedFor: string;
};

export type ReplaceCitationInput = {
  artifactId: string;
  citationId: string;
  sourceId: string;
  sourceType: string;
  sourceTitle: string;
  sourceUri: string;
  chunkHash: string;
  page: number | null;
  confidence: number;
};

export type CreateTaskInput = {
  title: string;
  description?: string | undefined;
  status?: "todo" | "in_progress" | "done" | "blocked" | undefined;
  priority?: "low" | "medium" | "high" | "critical" | undefined;
  assignee?: string | null | undefined;
  dueDate?: string | null | undefined;
  sourceId?: string | null | undefined;
  extractedItemId?: string | null | undefined;
  dependsOn?: string[] | undefined;
};

export type UpdateTaskInput = {
  title?: string | undefined;
  description?: string | undefined;
  status?: "todo" | "in_progress" | "done" | "blocked" | undefined;
  priority?: "low" | "medium" | "high" | "critical" | undefined;
  position?: number | undefined;
  assignee?: string | null | undefined;
  dueDate?: string | null | undefined;
  dependsOn?: string[] | undefined;
};

export type CreateAutomationInput = {
  name: string;
  trigger:
    | { kind: "schedule"; interval_seconds: number }
    | { kind: "on_generate"; template_id: string }
    | { kind: "on_kchat_message_match"; channel_id: string; regex: string };
  action: AutomationAction;
  enabled?: boolean | undefined;
};

export type SettingsUpdateInput = {
  theme?: "light" | "dark" | "system" | undefined;
  defaultExportFormat?: "markdown" | "html" | "csv" | "json" | undefined;
  ignorePatterns?: string[] | undefined;
  watchPatterns?: string[] | undefined;
  onboardingCompleted?: boolean | undefined;
  pinnedArtifactIds?: string[] | undefined;
  recentArtifactIds?: string[] | undefined;
  modelIdleTimeoutSecs?: number | undefined;
  telemetryEnabled?: boolean | undefined;
  appLockMode?: "off" | "pin" | "biometric" | "fido2" | undefined;
  enforceUpdateSignature?: boolean | undefined;
  enforceKeychainAcl?: boolean | undefined;
  simplifiedNav?: boolean | undefined;
  autoDownloadModel?: boolean | undefined;
  createPageMode?: "wizard" | "gallery" | undefined;
  resourceMode?: "lightweight" | "performance" | undefined;
  closeToTray?: boolean | undefined;
};

export type ExternalProviderConfigInput = {
  enabled: boolean;
  providerType: "custom" | "openai_compatible" | "anthropic";
  apiUrl: string;
  apiKeyRef: string;
  modelName: string;
  maxTokens: number;
  temperature: number;
  timeoutSecs: number;
  maxRetries: number;
};

export type ExternalProviderApiKeyInput = string | null;

export type EmbeddingModelSlug =
  | "all-MiniLM-L6-v2"
  | "paraphrase-multilingual-MiniLM-L12-v2"
  | "hash-trick";

export type DownloadableEmbeddingModelSlug =
  | "all-MiniLM-L6-v2"
  | "paraphrase-multilingual-MiniLM-L12-v2";

export type HybridSearchConfigUpdateInput = {
  bm25Weight?: number | undefined;
  vectorWeight?: number | undefined;
  rrfK?: number | undefined;
  recencyDecayEnabled?: boolean | undefined;
  recencyHalflifeSecs?: number | undefined;
  candidatePoolSize?: number | undefined;
  retentionWeight?: number | undefined;
};

export type GenerateRequestInput = {
  prompt: string;
  templateId?: string | undefined;
  sourceIds?: string[] | undefined;
  sectionIndex?: number | undefined;
  maxTokens?: number | undefined;
  temperature?: number | undefined;
};

export type TypstExportInput = {
  markup: string;
  format: "pdf" | "svg";
  outputPath?: string | undefined;
};

export type MarpExportInput = {
  markdown: string;
  format: "html" | "pdf" | "pptx";
  outputPath: string;
  theme?: string | undefined;
  includeNotes?: boolean | undefined;
  allowHtml?: boolean | undefined;
};

export type StartPresentationInput = {
  slides: { title: string; lines: string[]; notes: string }[];
  startIndex: number;
  deckTitle?: string | undefined;
};

export type GdriveSelectedItemsInput = {
  id: string;
  name: string;
  mimeType: string;
}[];

export type SaveDialogOptionsInput = {
  title?: string | undefined;
  defaultPath?: string | undefined;
  buttonLabel?: string | undefined;
  filters?: { name: string; extensions: string[] }[] | undefined;
};

export type OpenImageDialogInput = { title?: string | undefined };

export type VisionDescribeInput = {
  imagePath: string;
  mode: "describe" | "ocr" | "chart";
  maxTokens?: number | undefined;
};

export type GenerateImageInput = {
  prompt: string;
  width: number;
  height: number;
  artifactId: string;
  steps?: number | undefined;
  cfgScale?: number | undefined;
  seed?: number | undefined;
  negativePrompt?: string | undefined;
  sectionIndex?: number | undefined;
};

export type BackupConfigureInput = {
  autoBackup?: boolean | undefined;
  backupDir?: string | undefined;
  backupIntervalHours?: number | undefined;
  backupRetentionCount?: number | undefined;
};

export type BackupRestoreInput = { backupPath: string };

export type BundleExportInput = { outPath: string };

export type BundleImportInput = { bundlePath: string };

export type OpenDirectoryDialogInput = { title?: string | undefined };

export type OpenBundleDialogInput = { title?: string | undefined };

export type AutomationAction =
  | { kind: "reindex_source"; source_id: string }
  | {
      kind: "generate_from_template";
      template_id: string;
      source_ids: string[];
    }
  | { kind: "sequence"; actions: AutomationAction[] };
