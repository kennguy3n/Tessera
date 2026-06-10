/**
 * IPC handlers for the `vision:*` channels.
 *
 * Bridges the renderer's "describe / OCR / chart" requests to the
 * vision sidecar (`llama-server --mmproj` on port 8385) via the
 * `bridgeVisionDescribe` N-API call. Sidecar lifecycle is owned by
 * this module:
 *
 *   1. Read the installed vision-slot model record
 *      (`getCurrentModel(_, "vision")`). If absent, throw a structured
 *      "no vision model installed" error so the renderer can prompt
 *      a download.
 *   2. If the sidecar isn't running yet, populate its
 *      `modelPath` + `--mmproj <mmprojPath>` flags from the record and
 *      call `start()`. For low-tier hosts also append `--parallel 1`
 *      so the KV-cache budget halves on machines that can't afford
 *      concurrent decodes.
 *   3. Forward the call through `bridgeVisionDescribe` and return
 *      the response object directly. The 60 s idle-unload on
 *      `ModelSidecar` handles the cool-down — this handler does NOT
 *      stop the sidecar after a single call (consecutive vision
 *      requests during indexing would otherwise re-pay the multi-
 *      second model-load cost on every call).
 *
 * Distinct from `runtime:*` (registry / planning / on-disk download)
 * and `model:*` (text llama-server lifecycle + SSE generation). The
 * vision-slot sidecar lives on its own port (8385) and runs
 * independently from the text sidecar, so the text generator can
 * still stream tokens while a vision describe is in flight.
 */
import * as fsp from "fs/promises";

import { idempotentHandle } from "./register";
import { defaultRateLimiter, RATE_LIMIT_PROFILES } from "./rateLimiter";
import { VisionDescribeSchema } from "./schemas";
import {
  enforceSidecarExclusivity,
  ensureVisionSidecar,
  getBridge,
  getVisionSidecar,
  isBridgeAvailable,
} from "../appState";
import {
  detectPlatformInfo,
  getInstalledModel,
} from "../modelManagement";
import { app } from "electron";

function userDataDir(): string {
  return app.getPath("userData");
}

/**
 * Default per-mode token budget. The schema lets the renderer
 * override but the handler picks these as the floor so a buggy
 * renderer that drops `maxTokens` still produces useful output.
 *
 *   - describe: 512 tokens (~1-2 paragraphs). Free-form for the
 *     search index; the index doesn't benefit from longer
 *     descriptions (BM25 saturates around 200 tokens of body).
 *   - ocr: 2048 tokens. A dense full-page transcription can run
 *     ~1.5 k tokens of markdown, so 2 k is the realistic ceiling
 *     for OCR output.
 *   - chart: 1024 tokens. Structured chart-description prompts
 *     produce ~500-800 tokens of "type / axes / data points /
 *     trends / conclusions" output; doubling that is the
 *     headroom for complex multi-axis charts.
 */
const DEFAULT_MAX_TOKENS_BY_MODE = {
  describe: 512,
  ocr: 2048,
  chart: 1024,
} as const;

/**
 * Build the extra-args block passed to the vision sidecar.
 *
 *   - `--mmproj <path>`: required for every VLM. The projector is
 *     a separate GGUF (~190 MB SmolVLM, ~750 MB Qwen3.5) that
 *     llama-server reads alongside the language model.
 *   - `--parallel 1`: only emitted for low-tier hosts to halve the
 *     KV-cache memory budget. Mid/high tiers tolerate the default
 *     `--parallel 4` and benefit from it when the indexing
 *     pipeline batches images.
 *   - `--ctx-size`: derived from `ResolvedModel.contextLength` if
 *     populated; otherwise llama-server picks a sensible default
 *     from the GGUF header.
 *
 * Exported for tests so they can assert the argv shape without
 * launching the sidecar binary.
 */
export function buildVisionExtraArgs(
  mmprojPath: string,
  tier: "low" | "medium" | "high",
  contextLength: number | null | undefined,
): string[] {
  const args = ["--mmproj", mmprojPath];
  if (tier === "low") {
    args.push("--parallel", "1");
  }
  if (typeof contextLength === "number" && contextLength > 0) {
    args.push("--ctx-size", String(contextLength));
  }
  return args;
}

/**
 * Ensure the vision sidecar is running with the installed vision
 * model + projector loaded. Idempotent: calling repeatedly while
 * already-running is a no-op.
 *
 * Rejects with a structured error in three cases that the
 * renderer needs to disambiguate:
 *
 *   - "no vision model installed": user hasn't downloaded a VLM
 *     yet. The renderer should surface the model download flow.
 *   - "vision model file missing": active-model record points at
 *     a path that no longer exists (manual delete, disk fault).
 *     Renderer should prompt re-download.
 *   - "vision sidecar not initialised": bridge / appState isn't
 *     ready yet. Renderer should retry shortly.
 *
 * Exported for tests.
 */
export async function ensureVisionSidecarRunning(): Promise<void> {
  // LW-1: lazily construct the vision sidecar on first use instead of
  // at boot. Returns null only in fallback mode (bridge down).
  const sidecar = ensureVisionSidecar();
  if (!sidecar) {
    throw new Error("Vision sidecar not initialised");
  }
  if (sidecar.isRunning) return;

  // LW-2: in lightweight mode, starting vision stops any running
  // text / diffusion sidecar so only one model is resident at a
  // time. No-op in performance mode (concurrent text + vision).
  await enforceSidecarExclusivity("vision");

  const record = await getInstalledModel(userDataDir(), "vision");
  if (!record) {
    throw new Error(
      "No vision model installed — download one from Settings → Model runtime → Vision understanding",
    );
  }
  if (!record.mmprojPath) {
    // Every vision-capability manifest entry ships an mmproj URL
    // and the downloader writes its path onto the record; missing
    // here means the record was hand-edited or written by a pre-
    // multi-slot build. Tell the user to re-install.
    throw new Error(
      "Installed vision model is missing its multimodal projector (mmproj). Re-download the vision model from Settings.",
    );
  }
  // Defence-in-depth: the on-disk record points at an mmproj path
  // but the FILE may have disappeared since download (manual
  // delete, AV quarantine, partial disk fault). Catch that here
  // with a structured error rather than letting llama-server
  // exit with a cryptic "failed to load mmproj" line several
  // seconds later. `vision:isAvailable` performs the equivalent
  // stat for the probe path; this is its analogue for the
  // actual-startup path.
  try {
    await fsp.access(record.mmprojPath);
  } catch {
    throw new Error(
      "Vision model projector file is missing on disk. Re-download the vision model from Settings.",
    );
  }

  const platform = detectPlatformInfo();
  sidecar.setModelPath(record.path);
  sidecar.setExtraArgs(
    buildVisionExtraArgs(
      record.mmprojPath,
      platform.tier,
      // `record` is an `InstalledModelRecord` not a `ResolvedModel`
      // — context length isn't persisted on the record today, so
      // fall through to llama-server's GGUF-header default. The
      // function still threads the field as `null` so a future
      // record-shape change is a one-line update here.
      null,
    ),
  );
  await sidecar.start(true);
  // Block until llama-server's HTTP listener is up. Without this,
  // the first vision:describe after a cold-start races the
  // listener bind and rejects with ECONNREFUSED — see
  // ModelSidecar.waitForReady JSDoc. The default 60 s budget
  // covers VLM cold-starts including --mmproj load on slow disks.
  const ready = await sidecar.waitForReady();
  if (!ready) {
    // Drop the half-started sidecar: start() set _isRunning=true
    // the moment spawn() returned, but the HTTP listener never
    // came up. Leaving _isRunning=true would cause the next
    // ensure call (and any other consumer of
    // `sidecar.isRunning`) to silently no-op, hiding the
    // readiness failure from the user. Stop the sidecar first
    // so the next attempt re-spawns from a known-clean state.
    await sidecar.stop().catch(() => {
      // stop() best-effort — swallowing this error is safe
      // because the sidecar process is either already dead
      // (readiness probe failed because spawn crashed) or
      // will be reaped by the OS shortly. The user-visible
      // error from this function is the readiness failure,
      // not the stop failure.
    });
    throw new Error(
      "Vision sidecar failed to become ready within the startup window",
    );
  }
}

export function registerVisionHandlers(): void {
  idempotentHandle("vision:isAvailable", async () => {
    // Quick capability probe used by the renderer to decide
    // whether to show "Describe image" buttons. Returns true
    // when:
    //   (a) the native bridge is loaded,
    //   (b) a vision-slot model record exists,
    //   (c) the main-weights file the record points at is
    //       present on disk (`getInstalledModel` checks existence
    //       as part of its contract for `current.path`),
    //   (d) the `mmprojPath` companion is populated AND that file
    //       is ALSO present on disk.
    //
    // (d) is the load-bearing extra step over `getInstalledModel`:
    // vision-GGUF installs are two-file (main weights + mmproj
    // projector), but `getInstalledModel` only stat-checks the
    // main weights. If the mmproj is deleted, quarantined by AV,
    // or wiped by a partial-disk fault while the main weights
    // remain, the renderer would happily show the "Describe
    // image" button and the click would resolve to a confusing
    // llama-server startup failure because `--mmproj` points at
    // a missing path. Doing the stat here keeps the probe honest.
    //
    // Does NOT start the sidecar — probes are called at render
    // time and must be cheap. The sidecar warms up on the first
    // actual `vision:describe` call.
    if (!isBridgeAvailable()) return false;
    const record = await getInstalledModel(userDataDir(), "vision");
    if (!record || typeof record.mmprojPath !== "string") return false;
    try {
      await fsp.access(record.mmprojPath);
      return true;
    } catch {
      // mmproj file disappeared between download and probe (e.g.
      // user deleted it, AV quarantine, disk fault). Fall through
      // to false so the renderer hides the vision UI — the user
      // can re-download the model from Settings to recover.
      return false;
    }
  });

  idempotentHandle("vision:describe", async (_event, raw: unknown) => {
    const input = VisionDescribeSchema.parse(raw);

    defaultRateLimiter.consume(
      "vision:describe",
      RATE_LIMIT_PROFILES["vision:describe"],
    );

    await ensureVisionSidecarRunning();
    const sidecar = getVisionSidecar();
    if (!sidecar) {
      // ensureVisionSidecarRunning() would have thrown; this
      // narrow keeps TS happy and double-checks the postcondition.
      throw new Error("Vision sidecar not initialised");
    }
    const bridge = getBridge();
    if (!bridge) {
      throw new Error("Native bridge not available");
    }

    const maxTokens =
      input.maxTokens ?? DEFAULT_MAX_TOKENS_BY_MODE[input.mode];

    // Bracket the bridge call with markGenerationActive /
    // markGenerationIdle so `ModelSidecar`'s idle monitor (60 s
    // window in `sidecar.ts`) does NOT unload the vision sidecar
    // mid-call. Vision describe / OCR / chart calls run 5–15 s
    // typically, but OCR on large multi-page images can push past
    // the 60 s window on low-tier hosts — without bracketing the
    // sidecar dies mid-completion and the bridge call rejects with
    // an HTTP connection-reset error. Mirrors the pattern in
    // `ipc/model.ts` (text generation, lines ~372 / ~437).
    sidecar.markGenerationActive();
    try {
      // bridgeVisionDescribe runs entirely on a libuv worker thread
      // via napi-rs's AsyncTask, so the IPC handler returns to
      // Electron's main loop while the 5-15 s VLM call is in flight
      // — concurrent text generation and other IPCs stay responsive.
      return await bridge.bridgeVisionDescribe(
        sidecar.endpoint,
        input.imagePath,
        input.mode,
        maxTokens,
      );
    } finally {
      sidecar.markGenerationIdle();
    }
  });
}
