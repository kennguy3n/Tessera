/**
 * IPC handlers for the `runtime:*` channels (platform detection,
 * model registry, single-model on-disk enforcement).
 *
 * Sibling to `./model.ts` (live sidecar lifecycle). Keeping these
 * domains separate makes it explicit which calls touch the running
 * llama-server (`model:*`) vs. which calls only read/write the
 * on-disk model file + active-model.json record (`runtime:*`).
 */
import { app, ipcMain } from "electron";
import { getModelSidecar } from "../appState";
import {
  deleteCurrentModel,
  detectPlatformInfo,
  downloadModel,
  getInstalledModel,
  isModelInstalled,
  listModelsForPlatform,
  loadManifest,
  planDownload,
  recommendModel,
  resetManifestCache,
  type DownloadProgress,
  type ResolvedModel,
} from "../modelManagement";
import { assertId } from "./validate";
import { safeRendererSender } from "./model";

function userDataDir(): string {
  return app.getPath("userData");
}

/**
 * Stop the llama-server child process if it is currently running.
 *
 * The sidecar holds an OS-level file handle on the active model file
 * (mapped/read by `llama-server`). On Windows that handle blocks
 * `fsp.unlink`/`rename` with EPERM/EBUSY, so a swap or delete that
 * does not stop the sidecar first will fail. On macOS / Linux the
 * unlink succeeds (the open fd keeps the inode alive) but the orphaned
 * sidecar still holds port 8384 and continues serving the now-deleted
 * model, which collides with the next `model:start` and confuses
 * `model:status`.
 *
 * Every IPC entry-point that mutates the on-disk model file
 * (`runtime:downloadModel`, `runtime:deleteModel`) calls this BEFORE
 * the mutation. The renderer is expected to do the same as a UX
 * nicety, but we treat the server-side as the authoritative
 * enforcement point so direct IPC callers (tests, other windows,
 * future automation) get the same correctness.
 */
async function stopSidecarIfRunning(): Promise<void> {
  const sidecar = getModelSidecar();
  if (sidecar && sidecar.isRunning) {
    await sidecar.stop();
  }
}

function loadResolvedManifest() {
  // In production the manifest is bundled into <resources>/sidecars
  // and does not change at runtime, so the path-keyed cache in
  // modelManagement is correct as-is and we get a fast in-memory hit
  // on every model IPC. In development / tests we invalidate so:
  //   - `npm run dev` hot-reload picks up edits to sidecars/models.json
  //   - tests that switch fixtures via TESSERA_MODELS_MANIFEST always
  //     see the freshly-pointed file (the path-keyed cache also
  //     handles this naturally when the path differs; the explicit
  //     reset covers the edge case where the same path is re-used
  //     between fixtures).
  if (process.env.NODE_ENV !== "production") {
    resetManifestCache();
  }
  return loadManifest();
}

function findModelOrThrow(modelId: string): ResolvedModel {
  const info = detectPlatformInfo();
  const manifest = loadResolvedManifest();
  const model = listModelsForPlatform(manifest, info.platform).find(
    (m) => m.id === modelId,
  );
  if (!model) {
    throw new Error(
      `Model ${modelId} is not available on ${info.platformLabel}`,
    );
  }
  return model;
}

function progressEmitter(event: Electron.IpcMainInvokeEvent) {
  return safeRendererSender<DownloadProgress>(
    event,
    "runtime:downloadProgress",
  );
}

export function registerRuntimeHandlers(): void {
  ipcMain.handle("runtime:detectPlatform", async () => detectPlatformInfo());

  ipcMain.handle("runtime:recommendModel", async () => {
    const info = detectPlatformInfo();
    const manifest = loadResolvedManifest();
    return recommendModel(manifest, info.platform, info.tier);
  });

  ipcMain.handle("runtime:listModels", async () => {
    const info = detectPlatformInfo();
    const manifest = loadResolvedManifest();
    return listModelsForPlatform(manifest, info.platform);
  });

  ipcMain.handle("runtime:getCurrentModel", async () =>
    // Same "live record only" semantics as `runtime:planDownload` and
    // the `runtime:downloadModel` fast-path: if active-model.json
    // points at a file that's no longer on disk, treat it as no model
    // installed. Both ModelRuntimeCard and RuntimeStatus key off the
    // truthiness of the result to switch between the "Installed"
    // branch (Start / Delete buttons, Download hidden) and the "no
    // model" branch (Download visible). Exposing a ghost record would
    // make the Download button unreachable without first clicking
    // Delete. Stale records get cleaned up on the next
    // `downloadModelLocked` pass (it clears active-model.json when
    // `isModelInstalled` returns null but a record still exists).
    getInstalledModel(userDataDir()),
  );

  ipcMain.handle("runtime:planDownload", async (_event, modelId: unknown) => {
    const id = assertId(modelId, "modelId");
    const requested = findModelOrThrow(id);
    // Use `getInstalledModel`, not `getCurrentModel`, so that a stale
    // `active-model.json` record pointing at a manually-deleted file
    // is treated as "no model installed". Otherwise the planner
    // returns `already-installed` and the UI hides the Download
    // button, forcing the user to click "Delete model" to clear the
    // ghost record.
    const current = await getInstalledModel(userDataDir());
    return planDownload(current, requested);
  });

  ipcMain.handle(
    "runtime:downloadModel",
    async (event, modelId: unknown) => {
      const id = assertId(modelId, "modelId");
      const requested = findModelOrThrow(id);
      // Only stop the sidecar if we will actually mutate the model
      // file. Three cases:
      //   (a) Requested model is already installed AND file is still
      //       on disk -> no-op, do NOT touch the sidecar (avoid
      //       killing a running inference server when no download is
      //       needed).
      //   (b) Requested model is already installed but file is
      //       missing -> we must re-download. Stop the sidecar in
      //       case it's still pointing at the now-missing path.
      //   (c) A different model is installed (the swap case) ->
      //       `downloadModel` will evict the existing file. The
      //       eviction unlinks it, so we MUST stop the sidecar first
      //       — it holds the OS file handle and on Windows that
      //       blocks the unlink with EPERM/EBUSY.
      // There is intentionally no separate `runtime:swapModel`
      // channel: `downloadModel` already handles both fresh-install
      // and swap, so a second handler that called the same function
      // only invited drift.
      const installed = await isModelInstalled(userDataDir(), requested.id);
      if (installed) {
        return installed;
      }
      // The sidecar-stop runs INSIDE `withDownloadLock` via the
      // `beforeMutation` deps hook. Previously this call lived in the
      // IPC handler BEFORE the lock was acquired, which left a race
      // window: a parallel `runtime:downloadModel` invocation could
      // complete its own download in the gap between our sidecar-stop
      // and lock-acquire, and our subsequent eviction would then
      // delete a model the other tab had just successfully installed.
      // Moving it inside the lock makes the entire
      // (stop -> evict -> download) sequence atomic per userDataDir.
      return downloadModel(userDataDir(), requested, progressEmitter(event), {
        beforeMutation: stopSidecarIfRunning,
      });
    },
  );

  ipcMain.handle("runtime:deleteModel", async () => {
    // Sidecar-stop is wired through `beforeMutation` so it runs INSIDE
    // the per-userDataDir lock, after `deleteCurrentModel` has
    // verified that there is actually something to delete. See the
    // `runtime:downloadModel` handler above and the `beforeMutation`
    // doc on `DownloadDeps` for the race-window rationale.
    await deleteCurrentModel(userDataDir(), {
      beforeMutation: stopSidecarIfRunning,
    });
  });
}
