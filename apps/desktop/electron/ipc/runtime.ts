/**
 * IPC handlers for the `runtime:*` channels (platform detection,
 * model registry, single-model on-disk enforcement).
 *
 * Sibling to `./model.ts` (live sidecar lifecycle). Keeping these
 * domains separate makes it explicit which calls touch the running
 * llama-server (`model:*`) vs. which calls only read/write the
 * on-disk model file + active-model.json record (`runtime:*`).
 */
import { app } from "electron";
import { idempotentHandle } from "./register";
import { getModelSidecar } from "../appState";
import {
  ALL_MODEL_CAPABILITIES,
  deleteCurrentModel,
  detectPlatformInfo,
  detectComputeBackends,
  downloadModel,
  getInstalledModel,
  getInstalledModels,
  isCapabilityAvailable,
  isModelInstalled,
  listModelsForPlatform,
  loadManifest,
  parseModelCapability,
  planDownload,
  recommendModel,
  resetManifestCache,
  type DownloadProgress,
  type ModelCapability,
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
  // Capability filter is intentionally omitted here so a renderer
  // referring to a model by id alone can find it regardless of which
  // slot it belongs to. The slot is then derived from
  // `requested.capability` inside `downloadModel`, so the slot
  // routing is still authoritative.
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

/**
 * Coerce an IPC capability argument from the renderer into a
 * validated `ModelCapability`. Optional — when the renderer omits
 * it, defaults to "text" so existing single-capability call sites
 * keep working.
 *
 * Throws on unknown string values so a buggy renderer cannot
 * silently install a vision GGUF into the imagegen slot.
 */
function coerceCapability(input: unknown): ModelCapability {
  if (input === undefined || input === null) return "text";
  if (typeof input !== "string") {
    throw new Error(
      `capability must be a string ("text" | "vision" | "imagegen"); got ${typeof input}`,
    );
  }
  const parsed = parseModelCapability(input);
  if (parsed === null) {
    throw new Error(
      `Unknown model capability "${input}"; expected one of ${ALL_MODEL_CAPABILITIES.join(", ")}`,
    );
  }
  return parsed;
}

function progressEmitter(event: Electron.IpcMainInvokeEvent) {
  return safeRendererSender<DownloadProgress>(
    event,
    "runtime:downloadProgress",
  );
}

/**
 * Sidecar-stop is only relevant for the text-generation slot today:
 * the long-running `llama-server` child process loads only the text
 * model. Vision and imagegen sidecars are introduced in later
 * blocks; until those land, mutating the vision/imagegen slots
 * never collides with a running sidecar, so we skip the stop for
 * those capabilities.
 */
function sidecarStopperFor(capability: ModelCapability): () => Promise<void> {
  if (capability === "text") return stopSidecarIfRunning;
  return async () => undefined;
}

export function registerRuntimeHandlers(): void {
  idempotentHandle("runtime:detectPlatform", async () => detectPlatformInfo());

  idempotentHandle(
    "runtime:recommendModel",
    async (_event, capability: unknown) => {
      const cap = coerceCapability(capability);
      const info = detectPlatformInfo();
      const manifest = loadResolvedManifest();
      return recommendModel(manifest, info.platform, info.tier, cap);
    },
  );

  idempotentHandle(
    "runtime:listModels",
    async (_event, capability: unknown) => {
      const info = detectPlatformInfo();
      const manifest = loadResolvedManifest();
      // When the renderer omits a capability filter we return every
      // available model across all slots so the Settings UI can group
      // them per-section without N round-trips. When the renderer
      // explicitly passes a capability we narrow the list.
      if (capability === undefined || capability === null) {
        return listModelsForPlatform(manifest, info.platform);
      }
      const cap = coerceCapability(capability);
      return listModelsForPlatform(manifest, info.platform, cap);
    },
  );

  idempotentHandle(
    "runtime:getCurrentModel",
    async (_event, capability: unknown) => {
      const cap = coerceCapability(capability);
      // Same "live record only" semantics as `runtime:planDownload`
      // and the `runtime:downloadModel` fast-path: if a per-slot
      // active-model file points at an on-disk artifact that's no
      // longer there, treat it as no model installed. Both
      // ModelRuntimeCard and RuntimeStatus key off the truthiness of
      // the result to switch between the "Installed" branch (Start /
      // Delete buttons, Download hidden) and the "no model" branch
      // (Download visible). Exposing a ghost record would make the
      // Download button unreachable without first clicking Delete.
      // Stale records get cleaned up on the next `downloadModelLocked`
      // pass (it clears the per-slot active record when
      // `isModelInstalled` returns null but a record still exists).
      return getInstalledModel(userDataDir(), cap);
    },
  );

  idempotentHandle("runtime:getInstalledModels", async () =>
    // Aggregate snapshot of every slot for the Settings UI's
    // "currently installed across all capabilities" view. Single
    // round-trip — see `getInstalledModels` for shape.
    getInstalledModels(userDataDir()),
  );

  idempotentHandle(
    "runtime:isCapabilityAvailable",
    async (_event, capability: unknown) => {
      const cap = coerceCapability(capability);
      const info = detectPlatformInfo();
      const backends = detectComputeBackends();
      return isCapabilityAvailable(info.tier, cap, backends);
    },
  );

  idempotentHandle("runtime:planDownload", async (_event, modelId: unknown) => {
    const id = assertId(modelId, "modelId");
    const requested = findModelOrThrow(id);
    // Plan against the slot the requested model belongs to, NOT the
    // text slot. Without this, planning a vision install would see
    // the text slot's current record and either falsely report
    // "already installed" (if the text model id collided — unlikely
    // but possible across manifest revisions) or, more commonly,
    // produce a "swap" plan describing eviction of the text model
    // instead of the prior vision model. Use `getInstalledModel` so
    // a stale per-slot record pointing at a manually-deleted file
    // is treated as "no model installed".
    const current = await getInstalledModel(userDataDir(), requested.capability);
    return planDownload(current, requested);
  });

  idempotentHandle(
    "runtime:downloadModel",
    async (event, modelId: unknown) => {
      const id = assertId(modelId, "modelId");
      const requested = findModelOrThrow(id);
      // Only stop the sidecar if we will actually mutate the model
      // file AND the affected slot is the one the sidecar is serving
      // (text today; vision/imagegen sidecars stop themselves in
      // later blocks). Three cases:
      //   (a) Requested model is already installed in its slot AND
      //       file is still on disk -> no-op, do NOT touch the
      //       sidecar (avoid killing a running inference server when
      //       no download is needed).
      //   (b) Requested model is already installed but file is
      //       missing -> we must re-download. Stop the sidecar in
      //       case it's still pointing at the now-missing path.
      //   (c) A different model is installed in this slot (the swap
      //       case) -> `downloadModel` will evict the existing file.
      //       The eviction unlinks it, so we MUST stop the sidecar
      //       first — it holds the OS file handle and on Windows
      //       that blocks the unlink with EPERM/EBUSY.
      // There is intentionally no separate `runtime:swapModel`
      // channel: `downloadModel` already handles both fresh-install
      // and swap, so a second handler that called the same function
      // only invited drift.
      const installed = await isModelInstalled(
        userDataDir(),
        requested.capability,
        requested.id,
      );
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
      // (stop -> evict -> download) sequence atomic per slot.
      return downloadModel(userDataDir(), requested, progressEmitter(event), {
        beforeMutation: sidecarStopperFor(requested.capability),
      });
    },
  );

  idempotentHandle(
    "runtime:deleteModel",
    async (_event, capability: unknown) => {
      const cap = coerceCapability(capability);
      // Sidecar-stop is wired through `beforeMutation` so it runs
      // INSIDE the per-slot lock, after `deleteCurrentModel` has
      // verified that there is actually something to delete. See
      // the `runtime:downloadModel` handler above and the
      // `beforeMutation` doc on `DownloadDeps` for the race-window
      // rationale.
      await deleteCurrentModel(userDataDir(), cap, {
        beforeMutation: sidecarStopperFor(cap),
      });
    },
  );
}
