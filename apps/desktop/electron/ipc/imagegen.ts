/**
 * IPC handlers for the `imagegen:*` channels.
 *
 * Bridges the renderer's "Generate image" UI to the diffusion
 * sidecar (`sd-server` on port 8386) via the `bridgeGenerateImage`
 * N-API call.
 *
 * Lifecycle:
 *
 *   - The diffusion sidecar starts ONLY on an explicit
 *     `imagegen:generate` call — never at app boot, never on focus,
 *     never speculatively. Auto-starting would burn ~6 GB of VRAM
 *     on any machine that has an imagegen model installed.
 *   - Single in-flight generation. The sidecar is single-threaded
 *     under the hood (one CUDA context, one VRAM allocation), so
 *     two concurrent calls would double VRAM pressure and tank both.
 *     A `generationInFlight` flag enforces this at the IPC boundary
 *     so the rate limiter doesn't have to model concurrency.
 *   - 30 s idle-unload (configured on the sidecar itself in
 *     `appState.ts`). Generation is bursty — typically the user
 *     reviews each image for several minutes before regenerating —
 *     so the aggressive unload reclaims VRAM for other GPU
 *     workloads between batches.
 *
 * Output:
 *
 *   - PNG bytes returned from the bridge are written to
 *     `<userData>/generated-images/<artifactId>/<timestamp>-<seed>.png`.
 *     The filename embeds the seed for reproducibility and the
 *     timestamp so multiple generations against the same artifact
 *     don't collide.
 *   - The handler returns the path, the resolved seed (as Number —
 *     sd-server seeds fit comfortably in 2^53), and the size so the
 *     renderer can render the preview without re-reading the file.
 */
import * as fsp from "fs/promises";
import * as path from "path";

import { app } from "electron";

import { idempotentHandle } from "./register";
import { defaultRateLimiter, RATE_LIMIT_PROFILES } from "./rateLimiter";
import { GenerateImageSchema } from "./schemas";
import {
  detectComputeBackends,
  detectPlatformInfo,
  getInstalledModel,
  isCapabilityAvailable,
} from "../modelManagement";
import {
  getBridge,
  getDiffusionSidecar,
  isBridgeAvailable,
} from "../appState";

function userDataDir(): string {
  return app.getPath("userData");
}

/**
 * Cross-platform artifact-id sanitiser. The renderer passes its
 * own artifact identifiers, which are alphanumeric+dash by
 * construction today, but defence-in-depth strips any character
 * that could traverse the filesystem boundary. Empty result, or
 * any result that resolves to a pure `.` / `..` (or any sequence
 * of dots, which on some filesystems is also a parent-directory
 * traversal), is mapped to a deterministic fallback so the
 * resulting path is always well-formed AND can never escape the
 * `generated-images/<id>/` containment via `path.join()`.
 *
 * The earlier implementation allowed `.` and `..` to pass through
 * because dots are in the allowed character class, which let an
 * attacker (or a careless caller passing the literal string
 * `".."`) write the PNG directly into `<userData>/` instead of
 * the artifact subdirectory.
 *
 * Exported for tests.
 */
export function sanitiseArtifactId(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_\-.]/g, "");
  if (cleaned.length === 0 || /^\.+$/.test(cleaned)) {
    return "unknown-artifact";
  }
  return cleaned;
}

/**
 * Mutex-style flag tracking the single in-flight generation.
 * Module-scope so a future re-registration of the IPC handlers
 * (test harness, hot-reload) shares the same slot — same pattern
 * as `activeGenerationController` in `./model.ts`.
 */
let generationInFlight: AbortController | null = null;

/** Test-only reset for the in-flight slot. Production never calls this. */
export function _resetImagegenInFlightForTests(): void {
  generationInFlight = null;
}

/**
 * Probe whether image generation is even possible on this host.
 *
 *   1. Native bridge must be loaded (FFI fallback can't run the
 *      diffusion sidecar).
 *   2. Tier + compute backends must satisfy `isCapabilityAvailable`
 *      for `"imagegen"`: rejects low-tier hosts and any host
 *      without a GPU compute backend (cuda/vulkan/metal/rocm).
 *   3. An imagegen model record must exist on disk.
 *
 * Used by the renderer to gate the "Generate image" button so it
 * never appears on machines that fundamentally can't run
 * diffusion. Cheap — does not touch the sidecar.
 *
 * Exported for tests.
 */
export async function probeImagegenAvailable(): Promise<boolean> {
  if (!isBridgeAvailable()) return false;
  const platform = detectPlatformInfo();
  const backends = detectComputeBackends();
  if (!isCapabilityAvailable(platform.tier, "imagegen", backends)) {
    return false;
  }
  const record = await getInstalledModel(userDataDir(), "imagegen");
  return record !== null;
}

/**
 * Ensure the diffusion sidecar is running with the installed
 * imagegen model loaded. Same shape as
 * `ensureVisionSidecarRunning` in `./vision.ts` but for
 * sd-server. Differences:
 *
 *   - No mmproj concept (sd-server is a self-contained diffusion
 *     binary, no projector needed).
 *   - The "GPU only" invariant is enforced HERE in addition to
 *     the manifest filter — even if a user somehow downloaded an
 *     imagegen model onto a CPU-only host (e.g. by editing the
 *     manifest), we refuse to start the sidecar rather than spin
 *     up a diffusion job that would take >5 min per image.
 *
 * Exported for tests.
 */
export async function ensureDiffusionSidecarRunning(): Promise<void> {
  const sidecar = getDiffusionSidecar();
  if (!sidecar) {
    throw new Error("Diffusion sidecar not initialised");
  }
  if (sidecar.isRunning) return;

  const platform = detectPlatformInfo();
  const backends = detectComputeBackends();
  if (!isCapabilityAvailable(platform.tier, "imagegen", backends)) {
    throw new Error(
      "Image generation requires a GPU (CUDA / Vulkan / Metal / ROCm) on a medium- or high-tier host. This machine is " +
        `${platform.tier}-tier with backends [${backends.join(", ") || "none"}].`,
    );
  }

  const record = await getInstalledModel(userDataDir(), "imagegen");
  if (!record) {
    throw new Error(
      "No image-generation model installed — download one from Settings → Model runtime → Image generation",
    );
  }
  sidecar.setModelPath(record.path);
  await sidecar.start(true);
}

function nowIsoForFile(): string {
  // ISO timestamps contain `:` which is illegal in NTFS paths;
  // replace with `-`. Drop the millisecond fractional part to
  // keep filenames manageable.
  const iso = new Date().toISOString();
  return iso.replace(/[:.]/g, "-").replace(/Z$/, "");
}

export interface ImageGenResult {
  /** Absolute path to the written PNG. */
  path: string;
  /** Seed sd-server actually used. */
  seed: number;
  /** Width / height as resolved (echoes the request). */
  width: number;
  height: number;
  /** Wall-clock duration (ms) for the bridge call. */
  durationMs: number;
  /** Size of the PNG on disk (bytes). */
  sizeBytes: number;
}

export function registerImagegenHandlers(): void {
  idempotentHandle("imagegen:isAvailable", async () => {
    return await probeImagegenAvailable();
  });

  idempotentHandle("imagegen:cancel", async () => {
    // The bridge call uses napi-rs's AsyncTask which does NOT
    // expose a tokio cancellation token to the JS side — once
    // sd-server is mid-sample we can't interrupt the GPU work
    // without crashing the sidecar. The best we can do is abort
    // the AbortController so any subsequent step (file write,
    // metadata stamp) bails early, and report "cancel scheduled"
    // to the renderer.
    if (generationInFlight) {
      generationInFlight.abort();
      return { scheduled: true };
    }
    return { scheduled: false };
  });

  idempotentHandle(
    "imagegen:generate",
    async (_event, raw: unknown): Promise<ImageGenResult> => {
      const input = GenerateImageSchema.parse(raw);

      if (generationInFlight) {
        // Single in-flight invariant. The diffusion sidecar can
        // only sustain one generation at a time without VRAM
        // contention; queueing here would let the rate-limit
        // budget look "available" while the user actually waits
        // multiple 30 s slots in series. Fail fast instead.
        throw new Error(
          "Image generation already in flight — cancel or wait for the current generation before starting another",
        );
      }

      defaultRateLimiter.consume(
        "imagegen:generate",
        RATE_LIMIT_PROFILES["imagegen:generate"],
      );

      const controller = new AbortController();
      generationInFlight = controller;
      const t0 = Date.now();
      let activeSidecar: ReturnType<typeof getDiffusionSidecar> | null = null;
      try {
        await ensureDiffusionSidecarRunning();
        const sidecar = getDiffusionSidecar();
        if (!sidecar) {
          throw new Error("Diffusion sidecar not initialised");
        }
        const bridge = getBridge();
        if (!bridge) {
          throw new Error("Native bridge not available");
        }
        // Bracket the bridge call with markGenerationActive /
        // markGenerationIdle so the idle monitor in
        // `diffusionSidecar.ts` does NOT unload the sidecar
        // mid-generation. The 30 s idle window is shorter than the
        // typical 10–30 s sd-server generation, so without this
        // bracketing the monitor reliably kills the sd-server
        // process while it's still sampling — the JS side then
        // sees `bridgeGenerateImage` reject with a
        // connection-reset / ECONNRESET because the HTTP socket
        // disappears under it. Mirrors the pattern in
        // `ipc/model.ts` (text generation, lines ~372 / ~437).
        activeSidecar = sidecar;
        sidecar.markGenerationActive();

        const result = await bridge.bridgeGenerateImage(sidecar.endpoint, {
          prompt: input.prompt,
          width: input.width,
          height: input.height,
          steps: input.steps ?? null,
          cfgScale: input.cfgScale ?? null,
          seed: input.seed ?? null,
          negativePrompt: input.negativePrompt ?? null,
        });

        if (controller.signal.aborted) {
          // The bridge returned bytes but the user cancelled
          // before we could persist — discard the result.
          throw new Error("Image generation cancelled");
        }

        // Seed comes back as bigint from napi-rs (the Rust side
        // uses u64 to match sd-server's full range). Coerce to
        // Number — sd-server's seed space fits in 2^53 — but
        // clamp defensively so a future schema change can't
        // silently round-trip through Infinity.
        const seedBig = result.seed;
        const seedNum =
          seedBig <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(seedBig) : 0;

        // Resolve the containment root and the artifact directory
        // independently, then verify the artifact dir is strictly
        // nested under the root before writing. `sanitiseArtifactId`
        // is the first layer of defence (rejects pure `.` / `..` /
        // dot-only strings); this prefix check is a redundant
        // last-mile guard so any future regression in the sanitiser
        // — or any platform-specific quirk we missed — still cannot
        // escape `<userData>/generated-images/`. The check uses
        // `path.sep` as the suffix so we reject the exact root path
        // too (a `.` artifactId that somehow survives sanitisation
        // would otherwise resolve to the root itself, not a
        // subdirectory).
        const generatedRoot = path.resolve(
          userDataDir(),
          "generated-images",
        );
        const artifactDir = path.resolve(
          generatedRoot,
          sanitiseArtifactId(input.artifactId),
        );
        if (
          artifactDir !== generatedRoot &&
          !artifactDir.startsWith(generatedRoot + path.sep)
        ) {
          throw new Error(
            "Invalid artifactId — resolved path escapes the generated-images directory",
          );
        }
        if (artifactDir === generatedRoot) {
          // The sanitiser already maps `.` / `..` / `""` to
          // `unknown-artifact`, so the only way to land back on the
          // root is a future bug. Refuse rather than silently
          // dumping PNGs into the shared root.
          throw new Error(
            "Invalid artifactId — resolved to the generated-images root",
          );
        }
        await fsp.mkdir(artifactDir, { recursive: true });
        const filename = `${nowIsoForFile()}-${seedNum}.png`;
        const outPath = path.join(artifactDir, filename);

        // `result.pngBytes` is a Node Buffer marshalled from the
        // bridge — write it verbatim without re-encoding.
        await fsp.writeFile(outPath, result.pngBytes);

        const stat = await fsp.stat(outPath);
        return {
          path: outPath,
          seed: seedNum,
          width: input.width,
          height: input.height,
          durationMs: Date.now() - t0,
          sizeBytes: stat.size,
        };
      } finally {
        // Release the activity counter BEFORE clearing the
        // in-flight slot. `activeSidecar` is only set after
        // `ensureDiffusionSidecarRunning()` succeeded — if we
        // failed earlier (e.g. capability gating, no model
        // installed), the counter was never incremented and we
        // skip the decrement to avoid driving the count negative.
        if (activeSidecar !== null) {
          activeSidecar.markGenerationIdle();
        }
        // Clear ONLY if we are still the active controller. A
        // racing `imagegen:cancel` already aborted us but a
        // future call could have replaced the slot; this guards
        // against clobbering a successor controller.
        if (generationInFlight === controller) {
          generationInFlight = null;
        }
      }
    },
  );
}
