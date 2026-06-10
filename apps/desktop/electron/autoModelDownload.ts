/**
 * First-launch auto-download of the recommended text model (Session 5,
 * Step 1).
 *
 * Goal: make model setup zero-friction. On a fresh install we want the
 * recommended local text model to start downloading in the background
 * the moment the bridge is ready, so by the time the user finishes
 * onboarding their AI assistant is already (or nearly) set up — without
 * them ever visiting Settings → Models.
 *
 * This is the AUTHORITATIVE trigger. It runs once in the main process
 * after `init_bridge` succeeds (see `main.ts` → `initBridgeAndServices`)
 * and is the single place that decides whether a fresh install should
 * auto-fetch a model. The renderer `ModelDownloadBanner` is a pure
 * OBSERVER of `runtime:downloadProgress` — it no longer initiates the
 * download itself, so there is exactly one initiator and no double-start
 * race. (The existing per-slot download lock in `modelManagement` would
 * make a double-start safe anyway, but a single initiator is cleaner and
 * means the banner can't fire a redundant fetch on every mount.)
 *
 * Preconditions (ALL must hold), per the Session 5 spec:
 *   1. `autoDownloadModel !== false`  — user hasn't opted out.
 *   2. `onboardingCompleted === false` — genuine fresh install.
 *   3. No model already installed in the text slot.
 *   4. Network reachable — we DNS-probe the model's own download host
 *      (never a third-party beacon, so this stays privacy-preserving for
 *      SME tenants) so we don't kick off a doomed download and surface a
 *      scary "Setup failed" on a machine that is simply offline.
 *
 * The function NEVER throws: it is invoked with `void` from the boot
 * sequence, so any failure must degrade to "no auto-download" rather
 * than crash the process or wedge boot. It returns a small status enum
 * purely so tests (and the caller's debug log) can assert which branch
 * ran.
 */
import { app, BrowserWindow } from "electron";
import { promises as dns } from "node:dns";
import { loadConfig } from "./config";
import type { ModelDownloadError } from "../shared/types";
import {
  getInstalledModel,
  isDownloadAbortedError,
  type DownloadProgress,
  type InstalledModelRecord,
  type ModelCapability,
  type ResolvedModel,
} from "./modelManagement";
import {
  downloadRecommendedModel,
  resolveRecommendedModel,
} from "./ipc/runtime";
import { getLogger } from "./logger";

/**
 * Slot the first-launch auto-download targets. Only the text slot is
 * auto-fetched: it is the one that unlocks LLM-drafted generation, and
 * vision/imagegen are opt-in from Settings. Exported so tests and the
 * banner reference the same constant.
 */
export const AUTO_DOWNLOAD_CAPABILITY: ModelCapability = "text";

/** Outcome of an auto-download evaluation, for tests + debug logging. */
export type AutoDownloadOutcome =
  | "downloaded"
  | "already-installed"
  | "disabled"
  | "onboarded"
  | "no-candidate"
  | "offline"
  | "cancelled"
  | "error";

/**
 * Best-effort reachability probe for a download host. Resolves the host
 * via DNS with a short, unref'd timeout. Any failure (NXDOMAIN, timeout,
 * no network) resolves `false` — we degrade to "treat as offline" and
 * skip the auto-download rather than start a fetch that will fail.
 *
 * We only ever probe the host we are about to download FROM, so this is
 * not a third-party connectivity beacon — important for SME tenants who
 * may run on locked-down networks and treat unexpected outbound DNS as a
 * red flag.
 */
async function defaultIsOnline(host: string, timeoutMs = 3000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("dns lookup timed out")),
      timeoutMs,
    );
    // Never hold the event loop / process exit open on this probe.
    timer.unref?.();
  });
  try {
    await Promise.race([dns.lookup(host), timeout]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Extract the host to probe from a model's download URL. Returns `null`
 * for non-network URLs (e.g. a `file://` manifest pointing at a bundled
 * model or a local mirror path) so the caller can skip the DNS probe and
 * treat them as reachable.
 */
export function downloadHostFor(model: ResolvedModel): string | null {
  try {
    const parsed = new URL(model.url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.hostname;
    }
    return null;
  } catch {
    return null;
  }
}

/** Broadcast an event to every live renderer on `channel`. */
function broadcastToRenderers(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(channel, payload);
    } catch {
      // A single window's IPC being in a bad state must not abort the
      // broadcast to the others, nor escape this best-effort path.
    }
  }
}

function broadcastProgress(p: DownloadProgress): void {
  broadcastToRenderers("runtime:downloadProgress", p);
}

function broadcastError(e: ModelDownloadError): void {
  broadcastToRenderers("runtime:downloadError", e);
}

/** Injectable seams; defaults wire the real main-process implementations. */
export interface AutoDownloadDeps {
  loadConfig?: () => {
    autoDownloadModel: boolean;
    onboardingCompleted: boolean;
  };
  getInstalledModel?: (
    capability: ModelCapability,
  ) => Promise<InstalledModelRecord | null>;
  resolveRecommended?: (capability: ModelCapability) => ResolvedModel | null;
  isOnline?: (host: string) => Promise<boolean>;
  download?: (
    capability: ModelCapability,
    emit: (p: DownloadProgress) => void,
    preresolved?: ResolvedModel | null,
  ) => Promise<InstalledModelRecord | null>;
  broadcast?: (p: DownloadProgress) => void;
  broadcastError?: (e: ModelDownloadError) => void;
  logger?: Pick<ReturnType<typeof getLogger>, "info" | "warn">;
}

/**
 * Evaluate the preconditions and, if all hold, start (and await) the
 * recommended text-model download in the background. NEVER throws.
 */
export async function maybeAutoDownloadRecommendedModel(
  deps: AutoDownloadDeps = {},
): Promise<AutoDownloadOutcome> {
  const log = deps.logger ?? getLogger();
  const broadcast = deps.broadcast ?? broadcastProgress;
  const emitError = deps.broadcastError ?? broadcastError;

  // Phase 1 — gating. This staged sequence IS the single authoritative
  // precondition gate; there is intentionally no separate pure predicate
  // mirroring it. The checks run in increasing cost order and
  // short-circuit, which is a privacy property and not just an
  // optimisation: an opted-out or already-onboarded tenant must NOT be
  // DNS-probed, so the network check is reached only after the cheap,
  // I/O-free gates pass. A single all-inputs boolean predicate couldn't
  // preserve that ordering, and maintaining one alongside this would only
  // invite drift. Each early return names the exact reason for tests +
  // the caller's debug log.
  //
  // Failures here (e.g. an unreadable config) are silent: the user never
  // asked for a download, so we must NOT flash a "Setup failed" banner.
  // Bail to "error" quietly.
  let recommended: ResolvedModel;
  try {
    const cfg = (deps.loadConfig ?? loadConfig)();
    // Cheap gates first — no I/O, no network — so the common case (a
    // returning, already-onboarded user) bails out immediately.
    if (cfg.autoDownloadModel === false) return "disabled";
    if (cfg.onboardingCompleted !== false) return "onboarded";

    const getInstalled =
      deps.getInstalledModel ??
      ((capability: ModelCapability) =>
        getInstalledModel(app.getPath("userData"), capability));
    const existing = await getInstalled(AUTO_DOWNLOAD_CAPABILITY);
    if (existing) return "already-installed";

    const resolve = deps.resolveRecommended ?? resolveRecommendedModel;
    const candidate = resolve(AUTO_DOWNLOAD_CAPABILITY);
    if (!candidate) return "no-candidate";

    const host = downloadHostFor(candidate);
    const isOnline = deps.isOnline ?? defaultIsOnline;
    // A non-network URL (bundled/local mirror) needs no DNS probe.
    const online = host === null ? true : await isOnline(host);
    if (!online) return "offline";

    recommended = candidate;
  } catch (err) {
    safeWarn(log, "model.autoDownload.gateFailed", err);
    return "error";
  }

  // Phase 2 — the actual download. A failure HERE is a real, surfaced
  // setup failure: broadcast `runtime:downloadError` so the banner can
  // offer "Setup failed — retry". Still never throw (boot is awaiting a
  // bare `void`), and still best-effort — the app remains fully usable
  // in extraction-only mode.
  log.info("model.autoDownload.start", {
    modelId: recommended.id,
    capability: AUTO_DOWNLOAD_CAPABILITY,
    sizeMb: recommended.downloadSizeMb,
  });
  try {
    const download = deps.download ?? downloadRecommendedModel;
    // Hand the gate-phase `ResolvedModel` straight to the download so it
    // is NOT resolved a second time. The gate already resolved it (to
    // read the host for the DNS probe), and reusing that exact identity
    // means the model we install is provably the one the gate validated
    // and probed — collapsing the prior double resolution.
    const record = await download(
      AUTO_DOWNLOAD_CAPABILITY,
      broadcast,
      recommended,
    );
    if (!record) {
      // The gate phase resolved a candidate, but the download path
      // returned no record — e.g. a manifest race that re-resolved to
      // no candidate, or an injected `download` dep that legitimately
      // declines (cancelled, disk-full). Nothing was fetched and no
      // completion event was emitted, so reporting "downloaded" would
      // be a lie. Treat it as "no candidate"; this is NOT a surfaced
      // failure, so we stay silent (no `runtime:downloadError`).
      log.info("model.autoDownload.noCandidate", { modelId: recommended.id });
      return "no-candidate";
    }
    log.info("model.autoDownload.done", { modelId: recommended.id });
    return "downloaded";
  } catch (err) {
    // A user-initiated cancellation (the banner's "Skip — work without
    // AI" firing `runtime:cancelDownload`) is NOT a setup failure: the
    // user deliberately stopped it. Stay silent — do NOT broadcast
    // `runtime:downloadError`, which would flash a misleading "Setup
    // failed — retry" on the very banner the user just dismissed. The
    // `.partial` was already cleaned up inside the download lock.
    if (isDownloadAbortedError(err)) {
      log.info("model.autoDownload.cancelled", { modelId: recommended.id });
      return "cancelled";
    }
    safeWarn(log, "model.autoDownload.failed", err);
    try {
      emitError({
        capability: AUTO_DOWNLOAD_CAPABILITY,
        modelId: recommended.id,
        message: err instanceof Error ? err.message : String(err),
      });
    } catch {
      // Broadcasting the failure must itself never escape the boot path.
    }
    return "error";
  }
}

/** Log a warning without ever letting the diagnostic itself throw. */
function safeWarn(
  log: Pick<ReturnType<typeof getLogger>, "warn">,
  event: string,
  err: unknown,
): void {
  try {
    log.warn(event, {
      message: err instanceof Error ? err.message : String(err),
    });
  } catch {
    // Never let logging escape the best-effort boot path.
  }
}
