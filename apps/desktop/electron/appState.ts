import { app } from "electron";
import * as path from "path";
import * as fs from "fs";
import { ModelSidecar } from "./sidecar";
import { DiffusionSidecar, resolveDiffusionBinary } from "./diffusionSidecar";
import { getOrCreateDbKeyAsync, EncryptionUnavailableError } from "./dbKey";
import type {
  AddCitationRequest,
  ArtifactInfo,
  ArtifactVersionInfo,
  AutomationInfo,
  BackfillEmbeddingsResult,
  CitationInfo,
  CompareSourcesResult,
  EmbeddingProgressInfo,
  ExportResult,
  HybridSearchConfigInfo,
  HybridSearchConfigUpdate,
  IndexingProgressInfo,
  ReplaceCitationRequest,
  ReplaceCitationResult,
  SearchHitInfo,
  SourceDetailInfo,
  SourceInfo,
  TaskInfo,
  TemplateInfo,
} from "../shared/types";

// Re-export the canonical shared types so existing call sites that
// import them from "./appState" keep working. The single source of
// truth is `apps/desktop/shared/types.ts`.
export type {
  AddCitationRequest,
  ArtifactInfo,
  ArtifactVersionInfo,
  AutomationInfo,
  BackfillEmbeddingsResult,
  CitationInfo,
  CompareSourcesResult,
  ComparisonInfo,
  EmbeddingProgressInfo,
  HybridSearchConfigInfo,
  HybridSearchConfigUpdate,
  IndexedFileInfo,
  IndexingProgressInfo,
  ReplaceCitationRequest,
  ReplaceCitationResult,
  SearchHit,
  SearchHitInfo,
  SourceDetailInfo,
  SourceInfo,
  TaskInfo,
  TemplateInfo,
  ThemeInfo,
} from "../shared/types";

export interface NativeBridge {
  /**
   * Initialise the Rust-side workspace.
   *
   * `dbKey`, when provided, is the 64-character hex SQLCipher key
   * derived by `electron/dbKey.ts`. The Rust side issues
   * `PRAGMA key = "x'<hex>'"` on the connection and, on first launch
   * against a pre-encryption plaintext DB, transparently migrates
   * via `sqlcipher_export`. Pass `null` or omit to open the DB
   * unencrypted (only used in fallback / test paths).
   */
  initBridge(dbPath: string, templateDir: string, dbKey?: string | null): void;
  bridgeAddLocalFolder(path: string): SourceInfo;
  bridgeAddLocalFile(path: string): SourceInfo;
  bridgeListSources(): SourceInfo[];
  bridgeRemoveSource(sourceId: string): void;
  bridgeSearchSources(query: string, limit: number): SearchHitInfo[];
  bridgeGetSourceDetail(sourceId: string): SourceDetailInfo;
  bridgeReindexSource(sourceId: string): SourceInfo;
  bridgeGetIndexingProgress(sourceId: string): IndexingProgressInfo;
  /**
   * Trigger an embedding backfill pass over every chunk missing an
   * embedding for the active model. The Rust side is idempotent —
   * a second call against an up-to-date index reports `embedded=0`.
   * Pass `null` (or omit) to let the bridge pick its default batch
   * size.
   *
   * **Returns a `Promise`** — the Rust napi function is declared as
   * `AsyncTask<BackfillEmbeddingsTask>` so the heavy DB / embedding
   * work runs on a libuv worker thread (Node's built-in thread
   * pool) rather than blocking the JS main thread. The IPC handler
   * at `ipc/sources.ts:135` and every other consumer MUST `await`
   * the result; a non-awaited access (e.g.
   * `bridge.bridgeBackfillEmbeddings(null).embedded`) would silently
   * read `.embedded` off the Promise and get `undefined`.
   */
  bridgeBackfillEmbeddings(
    batchSize?: number | null,
  ): Promise<BackfillEmbeddingsResult>;
  bridgeGetEmbeddingProgress(): EmbeddingProgressInfo;
  bridgeGetHybridSearchConfig(): HybridSearchConfigInfo;
  bridgeUpdateHybridSearchConfig(
    update: HybridSearchConfigUpdate,
  ): HybridSearchConfigInfo;
  bridgeCreateArtifact(
    title: string,
    artifactType: string,
    templateId?: string | null,
  ): ArtifactInfo;
  bridgeUpdateArtifactContent(
    artifactId: string,
    content: string,
  ): ArtifactInfo;
  bridgeGetArtifact(artifactId: string): ArtifactInfo;
  bridgeListArtifacts(): ArtifactInfo[];
  bridgeDeleteArtifact(artifactId: string): void;
  bridgeExportArtifact(
    artifactId: string,
    format: string,
    contentOverride?: string | null,
  ): ExportResult;
  bridgeExportArtifactToFile(
    artifactId: string,
    format: string,
    path: string,
    contentOverride?: string | null,
  ): void;
  bridgeListTemplates(): TemplateInfo[];
  bridgeGetTemplate(templateId: string): TemplateInfo | null;
  bridgeListCitations(artifactId: string): CitationInfo[];
  bridgeAddCitation(req: AddCitationRequest): CitationInfo;
  bridgeRemoveCitation(artifactId: string, citationId: string): void;
  bridgeCheckSourceChanged(citationId: string): boolean;
  bridgeCheckCitationFreshness(citationId: string): string;
  bridgeReplaceCitation(req: ReplaceCitationRequest): ReplaceCitationResult;
  bridgeListVersions(artifactId: string): ArtifactVersionInfo[];
  bridgeRestoreVersion(artifactId: string, versionNumber: number): ArtifactInfo;
  bridgeGenerateFromTemplate(
    templateId: string,
    sourceIds: string[],
  ): ArtifactInfo;
  bridgeExtractTasksDecisions(sourceId: string): string;
  bridgeCompareSources(
    sourceIdA: string,
    sourceIdB: string,
  ): CompareSourcesResult;
  bridgeExportEvidencePack(artifactId: string, outputPath: string): string;
  // --- Tasks ---
  // `req_json` is a JSON-encoded `tessera_bridge::tasks::CreateTaskRequest`
  // / `UpdateTaskRequest`. JSON-tunneling is used because the napi macro
  // does not generate TS types for serde-default + Option-of-Option
  // fields cleanly; the bridge's serde_json deserialization gives the
  // backend full structural validation (including parse_opt_rfc3339).
  bridgeCreateTask(reqJson: string): TaskInfo;
  bridgeListTasks(): TaskInfo[];
  bridgeGetTask(taskId: string): TaskInfo | null;
  bridgeUpdateTask(taskId: string, reqJson: string): TaskInfo;
  bridgeDeleteTask(taskId: string): boolean;
  bridgeReorderTasks(status: string, ids: string[]): void;
  // --- Automations ---
  bridgeCreateAutomation(reqJson: string): AutomationInfo;
  bridgeListAutomations(): AutomationInfo[];
  bridgeGetAutomation(automationId: string): AutomationInfo | null;
  bridgeSetAutomationEnabled(automationId: string, enabled: boolean): void;
  bridgeDeleteAutomation(automationId: string): boolean;
  /** Enabled `Schedule` automations whose `next_scheduled_at <= now`. */
  bridgeDueScheduledAutomations(): AutomationInfo[];
  /** Enabled `OnGenerate` automations tied to the given template string id
   *  (e.g. `"prd-v1"`). The bridge hashes the id via
   *  `TemplateId::from_string` to match the UUID5 stored on the trigger. */
  bridgeMatchingOnGenerateAutomations(templateId: string): AutomationInfo[];
  /** Persist a run result. `status` is rendered verbatim by the UI. */
  bridgeRecordAutomationRun(automationId: string, status: string): void;
  // --- Audit pass-throughs (the audit code) ---
  //
  // The events below are emitted from JS-side IPC handlers
  // (`ipc/settings.ts`, `ipc/model.ts`, `ipc/connectors/handlers.ts`)
  // and routed through the Rust audit store via these pass-throughs
  // so every audit event lives in the same SQLite append-only table
  // as the bridge-internal ones. Each method is a no-throw, no-await
  // best-effort call — failure to append an audit row must never
  // propagate back to the IPC handler (see Rust-side rationale in
  // `napi_exports.rs`).
  bridgeLogSettingsChanged(setting: string, value: string): void;
  bridgeLogModelStarted(modelId: string): void;
  bridgeLogModelStopped(reason: string): void;
  bridgeLogConnectorConnected(provider: string): void;
  bridgeLogConnectorSynced(
    provider: string,
    added: number,
    updated: number,
    removed: number,
  ): void;
  bridgeLogConnectorDisconnected(provider: string, filesRemoved: number): void;
  // --- Vision + image generation ---
  //
  // Async bridges that talk to local sidecars:
  //   - `bridgeVisionDescribe` → `llama-server --mmproj` on
  //     port 8385 (managed by `visionSidecar` here).
  //   - `bridgeGenerateImage`  → `sd-server` on port 8386
  //     (managed by `diffusionSidecar` here, started on
  //     explicit user action only).
  // Both return Promises (the napi side wraps the inner async
  // `tessera_runtime` calls in `AsyncTask`s) so the JS main
  // process event loop stays free during the 10-30 s sidecar
  // call.

  /**
   * Run a vision completion against a `llama-server --mmproj`
   * sidecar. Used by the indexing pipeline (image description,
   * OCR for scanned PDFs, chart extraction) and by Block-E user
   * features (whiteboard transcription, ask-about-image).
   *
   * `mode` selects a pre-tuned prompt:
   *   - `"describe"`: free-form image description for the search
   *     index.
   *   - `"ocr"`: verbatim text transcription, preserving layout
   *     in markdown.
   *   - `"chart"`: structured chart / diagram summary.
   *
   * Resolves with `{ content, stop, tokensPredicted,
   * tokensEvaluated }`. Rejects with the sidecar's HTTP status
   * line + body on failure (e.g. `HTTP 503: overloaded`) or with
   * the underlying I/O error if `imagePath` can't be read.
   */
  bridgeVisionDescribe(
    endpoint: string,
    imagePath: string,
    mode: "describe" | "ocr" | "chart",
    maxTokens: number,
  ): Promise<{
    content: string;
    stop: boolean;
    tokensPredicted: number;
    tokensEvaluated: number;
  }>;
  /**
   * Generate one image via the sd-server diffusion sidecar.
   * Used by the `imagegen:generate` IPC handler.
   *
   * `steps`, `cfgScale`, `seed`, and `negativePrompt` are
   * optional — pass `null` to fall back to FLUX.2-klein's
   * recommended sampling settings baked into the Rust side.
   *
   * Resolves with `{ pngBytes: Buffer, seed: BigInt }`.
   * `pngBytes` is the raw PNG payload (the IPC handler writes it
   * to `<userData>/generated-images/<artifactId>/<n>.png`).
   * `seed` is what sd-server actually used (caller-supplied or
   * server-chosen) so the artifact can persist it for
   * "regenerate in the same style" workflows.
   */
  bridgeGenerateImage(
    endpoint: string,
    request: {
      prompt: string;
      width: number;
      height: number;
      steps: number | null;
      cfgScale: number | null;
      seed: number | null;
      negativePrompt: string | null;
    },
  ): Promise<{ pngBytes: Buffer; seed: bigint }>;
}

let bridge: NativeBridge | null = null;
let modelSidecar: ModelSidecar | null = null;
// Vision sidecar runs the same `llama-server` binary as the text
// sidecar but on a separate port (8385) and with `--mmproj`
// appended so the multimodal projector is loaded alongside the
// language model. Lifecycle is on-demand — the IPC handler that
// answers vision requests warms it up on first use rather than at
// app boot, so a machine that never asks for a VLM never pays the
// memory cost. The 60 s idle-unload matches the text sidecar.
let visionSidecar: ModelSidecar | null = null;
// Diffusion sidecar (sd-server / stable-diffusion.cpp) is bigger
// still (~6 GB VRAM for FLUX.2-klein) and starts ONLY on explicit
// user action — the renderer's "Generate image" button — never at
// boot, never on app focus, never on speculative warm-up. The 30 s
// idle-unload reflects bursty user interaction (generate / edit /
// re-generate) typical of the image-gen workflow.
let diffusionSidecar: DiffusionSidecar | null = null;

function resolveNativeAddon(): NativeBridge | null {
  // The compiled main bundle now lives at `dist-electron/electron/main.js`
  // (Workstream 1 sibling-rooted layout — see `tsconfig.electron.json`),
  // so `__dirname` at runtime is `<desktop>/dist-electron/electron/`.
  // The `__dirname`-relative fallbacks below compensate by going up
  // one more level than they did before; without this they'd resolve
  // inside `dist-electron/` itself (which never contains a sibling
  // `native/` directory) and degenerate into dead paths.
  const possiblePaths = [
    path.join(app.getAppPath(), "native", "tessera_bridge.node"),
    path.join(app.getAppPath(), "..", "native", "tessera_bridge.node"),
    path.join(__dirname, "..", "..", "native", "tessera_bridge.node"),
    // Sibling-of-main: build scripts that drop the .node binary next
    // to `main.js` end up at `dist-electron/electron/<binary>`.
    path.join(__dirname, "tessera_bridge.node"),
    // Legacy sibling-of-`dist-electron`: covers the historical layout
    // where main.js was at `dist-electron/main.js`.
    path.join(__dirname, "..", "tessera_bridge.node"),
  ];

  for (const addonPath of possiblePaths) {
    if (fs.existsSync(addonPath)) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require(addonPath) as NativeBridge;
      } catch {
        continue;
      }
    }
  }
  return null;
}

export async function initAppState(): Promise<boolean> {
  bridge = resolveNativeAddon();
  if (!bridge) {
    console.warn(
      "[Tessera] Native bridge not found. Running in fallback mode.",
    );
    return false;
  }

  const userData = app.getPath("userData");
  const dbPath = path.join(userData, "tessera.db");
  const templateDir = path.join(app.getAppPath(), "templates");

  // Derive the SQLCipher key. Two-tier failure handling:
  //
  // - `EncryptionUnavailableError` means NEITHER `safeStorage` NOR
  //   the password-derived vault is available to wrap the cipher
  //   key. The boot contract is that the call sequence
  //   in `main.ts` runs `maybeInitPasswordVault()` BEFORE
  //   `initAppState()`, so by the time we reach this code the
  //   vault has either been unlocked (in which case
  //   `getOrCreateDbKeyAsync` uses it transparently to wrap the
  //   cipher key) or it's verifiably absent. Falling through to an
  //   unencrypted bridge is the right degradation path because the
  //   on-disk DB is either fresh or was previously opened
  //   unencrypted — there is no encrypted state to lose.
  //
  // - Any OTHER error from `getOrCreateDbKeyAsync` (zero-byte key
  //   file, wrong decrypted length, decrypt failure from a userData
  //   dir copied to a different machine, wrong vault password)
  //   means the user previously had encryption working and the key
  //   is now lost or corrupted. The on-disk DB is almost certainly
  //   encrypted, so we MUST NOT fall back to unencrypted mode —
  //   doing so would either fail noisily at the next `CREATE TABLE`
  //   or, in the corner case where the DB doesn't yet exist,
  //   silently regress to plaintext storage without the user
  //   realising. Refuse to bring up the bridge and surface the
  //   actionable recovery message (`db.key` corrupt → restore from
  //   backup or accept data loss).
  let dbKey: string | null = null;
  try {
    dbKey = await getOrCreateDbKeyAsync();
  } catch (keyErr) {
    if (keyErr instanceof EncryptionUnavailableError) {
      console.warn(
        "[Tessera] Database encryption unavailable — running in unencrypted mode.",
        keyErr.message,
      );
    } else {
      console.error(
        "[Tessera] Database key is unrecoverable. Refusing to bring up the bridge to avoid corrupting an existing encrypted database.",
        keyErr,
      );
      console.error(
        "[Tessera] Recovery: restore <userData>/db.key from backup, or delete both <userData>/db.key and <userData>/tessera.db to start fresh (data loss).",
      );
      bridge = null;
      return false;
    }
  }

  try {
    bridge.initBridge(dbPath, templateDir, dbKey);
    console.log(
      "[Tessera] Native bridge initialized:",
      dbPath,
      dbKey ? "(encrypted)" : "(UNENCRYPTED — keyring unavailable)",
    );
  } catch (err) {
    console.error("[Tessera] Failed to initialize native bridge:", err);
    bridge = null;
    return false;
  }

  modelSidecar = new ModelSidecar({
    binaryPath: resolveSidecarBinary(),
    port: 8384,
    label: "text",
  });
  // Vision sidecar reuses the same llama-server binary but binds a
  // distinct port so it can run concurrently with the text sidecar
  // — concurrent text + vision is a real workflow (the artifact
  // generator pulls VLM descriptions of source images while the
  // text generator is mid-stream).
  //
  // `modelPath` and `extraArgs` are unset here intentionally; the
  // vision IPC handler populates both from the installed vision
  // record (which carries `path` + `mmprojPath`) before calling
  // `start()`. Starting now without a model would throw.
  visionSidecar = new ModelSidecar({
    binaryPath: resolveSidecarBinary(),
    port: 8385,
    label: "vision",
  });
  diffusionSidecar = new DiffusionSidecar({
    binaryPath: resolveDiffusionBinary(
      app.getAppPath(),
      __dirname,
      (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath,
    ),
    port: 8386,
    label: "diffusion",
  });
  console.log(
    "[Tessera] Model sidecars configured (text=8384 vision=8385 diffusion=8386)",
  );

  return true;
}

function resolveSidecarBinary(): string {
  const ext = process.platform === "win32" ? ".exe" : "";
  const binaryName = `llama-server${ext}`;
  // electron-builder copies sidecars/llama-server/ into process.resourcesPath/sidecars/llama-server
  // for packaged builds. In dev we look relative to the repo root.
  // `__dirname` at runtime is `<desktop>/dist-electron/electron/` (see
  // the comment in `resolveNativeAddon` above), so the relative paths
  // below climb two extra levels to land at `<desktop>/` and
  // `<repo>/apps/` respectively — the `../../..` entry does NOT reach
  // the repo root, it reaches `apps/`, which is consistent with how the
  // earlier `../..` lookup behaved. Without the depth bump these would
  // silently resolve inside `dist-electron/`.
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath;
  const possiblePaths = [
    resourcesPath &&
      path.join(resourcesPath, "sidecars", "llama-server", binaryName),
    path.join(app.getAppPath(), "sidecars", "llama-server", binaryName),
    path.join(app.getAppPath(), "..", "sidecars", "llama-server", binaryName),
    // `<desktop>/sidecars/...` (was previously the first `__dirname` entry).
    path.join(__dirname, "..", "..", "sidecars", "llama-server", binaryName),
    // `<repo>/apps/sidecars/...` (was previously the second entry — kept
    // for backwards compat even though the directory is not at the
    // canonical repo-root `sidecars/` location).
    path.join(
      __dirname,
      "..",
      "..",
      "..",
      "sidecars",
      "llama-server",
      binaryName,
    ),
  ].filter((p): p is string => typeof p === "string");
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return p;
  }
  return binaryName;
}

export function getBridge(): NativeBridge | null {
  return bridge;
}

export function isBridgeAvailable(): boolean {
  return bridge !== null;
}

export function getModelSidecar(): ModelSidecar | null {
  return modelSidecar;
}

/**
 * Vision sidecar accessor. Returns `null` when the native bridge
 * isn't initialised (fallback mode) or when initialisation was
 * skipped — the caller is responsible for warming it up on demand
 * once a vision request is made. The lifecycle contract is:
 *   1. The vision IPC handler reads the current vision slot's
 *      `InstalledModelRecord` (via `getCurrentModel(_, "vision")`).
 *   2. If no record, surface "no vision model installed" to the
 *      renderer and DO NOT call `setModelPath` (start() would
 *      throw).
 *   3. If a record exists, call `setModelPath(record.path)` and
 *      `setExtraArgs(["--mmproj", record.mmprojPath, ...])` then
 *      `start()`. For low-tier (`tier === "low"`) hosts, also append
 *      `--parallel 1` to halve the KV-cache budget.
 *   4. Idle-unload is automatic after 60 s; the next vision request
 *      re-runs steps 1-3.
 */
export function getVisionSidecar(): ModelSidecar | null {
  return visionSidecar;
}

/**
 * Diffusion sidecar accessor. Same null-on-fallback contract as
 * `getVisionSidecar`, but with a stricter on-demand contract: the
 * sidecar must NEVER be started until the user explicitly clicks
 * "Generate image" in the InfographicEditor / LandingPageEditor.
 * Auto-starting would burn ~6 GB of VRAM at app boot on any host
 * that has an imagegen model installed, which would brick the
 * machine for anyone running other GPU workloads (gaming, CUDA
 * compute, video editing).
 */
export function getDiffusionSidecar(): DiffusionSidecar | null {
  return diffusionSidecar;
}

/**
 * Graceful shutdown for every initialised sidecar. Called from
 * `main.ts`'s `will-quit` handler so an orderly app exit delivers
 * SIGTERM (with the 5 s SIGKILL fallback inside each sidecar's
 * `stop()`) instead of relying on the synchronous `process.on("exit")`
 * SIGKILL handler each sidecar installs as a last-resort orphan
 * guard.
 *
 * Stops are best-effort: a stop failure on one sidecar must not
 * prevent the others from being torn down, and must not block app
 * exit — the process.on("exit") SIGKILL fallback is there exactly
 * for the case where this graceful path doesn't complete in time.
 * Errors are logged so an audit can tell graceful vs. forced
 * shutdowns apart.
 */
export async function stopAllSidecars(): Promise<void> {
  const tasks: Array<Promise<void>> = [];
  if (modelSidecar) {
    tasks.push(
      modelSidecar.stop().catch((err) => {
        console.error("[tessera] text sidecar stop failed:", err);
      }),
    );
  }
  if (visionSidecar) {
    tasks.push(
      visionSidecar.stop().catch((err) => {
        console.error("[tessera] vision sidecar stop failed:", err);
      }),
    );
  }
  if (diffusionSidecar) {
    tasks.push(
      diffusionSidecar.stop().catch((err) => {
        console.error("[tessera] diffusion sidecar stop failed:", err);
      }),
    );
  }
  await Promise.all(tasks);
}
