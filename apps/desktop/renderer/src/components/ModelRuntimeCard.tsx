import { useCallback, useEffect, useState } from "react";
import Card from "./Card";
import Button from "./Button";
import type {
  InstalledModelRecord,
  ModelDownloadProgress,
  ModelStatus,
  PlatformInfo,
  ResolvedModel,
} from "../types/ipc";

interface ModelRuntimeCardProps {
  /** Optional override used by tests; falls back to `window.tessera`. */
  api?: Window["tessera"];
}

interface State {
  loading: boolean;
  error: string | null;
  platform: PlatformInfo | null;
  models: ResolvedModel[];
  recommended: ResolvedModel | null;
  current: InstalledModelRecord | null;
  status: ModelStatus | null;
  progress: ModelDownloadProgress | null;
  busyModelId: string | null;
  showAll: boolean;
}

const initialState: State = {
  loading: true,
  error: null,
  platform: null,
  models: [],
  recommended: null,
  current: null,
  status: null,
  progress: null,
  busyModelId: null,
  showAll: false,
};

function backendsToLabel(backends: string[]): string {
  if (backends.length === 0) return "—";
  if (backends.length === 1 && backends[0] === "cpu") return "CPU (AVX2)";
  return backends
    .map((b) => {
      switch (b) {
        case "metal":
          return "Metal";
        case "cuda":
          return "CUDA";
        case "vulkan":
          return "Vulkan";
        case "rocm":
          return "ROCm";
        case "cpu":
          return "CPU";
        default:
          return b;
      }
    })
    .join(" / ");
}

function gpuLabel(backends: string[]): string {
  const gpus = backends.filter((b) => b !== "cpu");
  if (gpus.length === 0) return "CPU-only";
  return backendsToLabel(gpus);
}

export default function ModelRuntimeCard({ api }: ModelRuntimeCardProps) {
  const tessera = api ?? (typeof window !== "undefined" ? window.tessera : undefined);
  const [state, setState] = useState<State>(initialState);

  const refresh = useCallback(async () => {
    if (!tessera) return;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      // Every IPC call on this card is text-slot scoped. The
      // `recommendModel` / `getCurrentModel` overloads without a
      // capability arg already default to `"text"` for backward
      // compat (see `apps/desktop/shared/types.ts:1045-1061`), but
      // `listModels()` with no arg explicitly returns ALL capabilities
      // (see `apps/desktop/electron/ipc/runtime.ts:165-171`) so the
      // multi-slot Settings UI can group them per-section in one
      // round-trip. Without an explicit `"text"` here, the text
      // card's "Show all available models" list would render vision
      // + imagegen entries with actionable Download / Swap buttons.
      // Clicking Download on a vision entry from this card would
      // route to the vision slot (via the manifest capability) but
      // set `state.current` to the returned vision record, leaving
      // the text card showing a vision model as "Installed" with
      // text-slot Start / Delete buttons — which would then call
      // `model.start(visionPath)` against the text sidecar or
      // `deleteModel()` (text-default) against the actual text slot.
      // Scoping to `"text"` here closes the leak at the boundary.
      const [platform, models, recommended, current, status] = await Promise.all([
        tessera.runtime.detectPlatform(),
        tessera.runtime.listModels("text"),
        tessera.runtime.recommendModel("text"),
        tessera.runtime.getCurrentModel("text"),
        tessera.model.status(),
      ]);
      setState((s) => ({
        ...s,
        loading: false,
        platform,
        models,
        recommended,
        current,
        status,
      }));
    } catch (err) {
      setState((s) => ({
        ...s,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }, [tessera]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Subscribe to download-progress events, but only paint events for
  // the TEXT slot into this card. The multi-slot Settings UI added in
  // Block F enables concurrent vision / imagegen downloads in the
  // sibling `ModelSlotPanel` cards (the per-slot download lock at
  // `modelManagement.ts:1909-1944` is keyed by `(userDataDir,
  // capability)` so different slots can run in parallel once the
  // global 5s rate-limiter gap has elapsed). Without this filter, a
  // vision-slot progress event would overwrite the text card's
  // progress bar with another slot's filename + percentage. Legacy
  // events that predate the `capability` field (capability ===
  // undefined) are treated as text-slot events for backward
  // compatibility — the main process now always tags new events, so
  // these only appear if a stale renderer is talking to a newer main.
  useEffect(() => {
    if (!tessera) return;
    return tessera.runtime.onDownloadProgress((p: ModelDownloadProgress) => {
      if (p.capability !== undefined && p.capability !== "text") return;
      setState((s) => ({ ...s, progress: p }));
    });
  }, [tessera]);

  // Lightweight 5-second poll for the two CHEAP values — sidecar
  // `status()` and on-disk `getCurrentModel()` — so the Settings card
  // stays in sync with the sidebar's `RuntimeStatus` (which polls the
  // same pair at the same cadence). Without this, a sidecar crash or an
  // out-of-band model deletion shows up in the sidebar within ~5s but
  // requires the user to navigate away and back to refresh the Settings
  // card — a confusing asymmetry.
  // We deliberately do NOT re-poll the EXPENSIVE values
  // (`detectPlatform`, `listModels`, `recommendModel`): hardware
  // detection can take up to ~3s on a cold Electron process because of
  // `nvidia-smi` / `vulkaninfo` shells, and the model registry is a
  // function of the shipped manifest which doesn't change at runtime.
  // The initial `refresh()` covers them once on mount; the poll covers
  // only what can change.
  useEffect(() => {
    if (!tessera) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const [status, current] = await Promise.all([
          tessera.model.status(),
          tessera.runtime.getCurrentModel("text"),
        ]);
        if (cancelled) return;
        setState((s) => {
          // Skip poll updates while a user-initiated operation is in
          // flight (download / swap / delete). Otherwise the poll could
          // overwrite optimistic state — e.g. `handleDelete` nulls
          // `current` before the main process finishes evicting the
          // file, and a poll tick landing in that window would re-fetch
          // the still-on-disk model and "resurrect" it in the UI for
          // up to 5s. The functional setState reads `s.busyModelId` at
          // commit time, so the gate is race-free against `setState`
          // calls from the user-action handlers.
          if (s.busyModelId !== null) return s;
          return { ...s, status, current };
        });
      } catch {
        if (cancelled) return;
        // Match RuntimeStatus's failure-mode: surface as a stopped
        // sidecar in `status`, but leave `current` untouched so a
        // transient IPC blip doesn't blank out the model record the
        // user just downloaded. Also gated on `busyModelId` so we
        // don't flip `status` to "error" while a download is mid-flight
        // (the download path manages its own status reporting).
        setState((s) => {
          if (s.busyModelId !== null) return s;
          return {
            ...s,
            status: { available: false, modelName: null, status: "error" },
          };
        });
      }
    };
    const id = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [tessera]);

  const performDownload = useCallback(
    async (modelId: string) => {
      if (!tessera) return;
      setState((s) => ({ ...s, busyModelId: modelId, error: null, progress: null }));
      try {
        // `runtime:downloadModel` handles both fresh-install and swap. The
        // main process stops the sidecar before evicting any old model,
        // so we don't need to special-case the swap path from the UI.
        const record = await tessera.runtime.downloadModel(modelId);
        // The main-process swap path stops the sidecar (so the OS file
        // handle on the old model is released before unlink). Re-fetch
        // status so the UI doesn't keep showing the pre-swap "running"
        // indicator when the runtime is actually stopped.
        //
        // Also re-fetch the live `getCurrentModel("text")` record
        // rather than using the synchronous `downloadModel` return
        // value. The main process commits additional metadata to the
        // active-model file AFTER the download finishes (sha256
        // verification, content-length echo, mtime stamp), and there's
        // a small window where the IPC response is in flight but the
        // on-disk record hasn't yet picked up the final stamp. Using
        // the live record matches the invariant that
        // `state.current` == on-disk-truth on every settled boundary,
        // identical to the pattern `ModelSlotPanel` uses for the
        // vision / imagegen slots. The IPC return value is the
        // fallback for the case where the post-download fetch fails
        // (e.g. transient permission error) so we never leave
        // `state.current` null on a successful download.
        const [status, liveCurrent] = await Promise.all([
          tessera.model.status().catch(() => null),
          tessera.runtime.getCurrentModel("text").catch(() => null),
        ]);
        setState((s) => ({
          ...s,
          busyModelId: null,
          current: liveCurrent ?? record,
          progress: null,
          status: status ?? s.status,
        }));
      } catch (err) {
        // Clear `progress` on failure too. The main process simply stops
        // emitting `runtime:downloadProgress` events when a download
        // fails — there is no terminal "failed" event — so without this
        // the last in-flight snapshot (e.g. "42 / 1000 MB (4%)") would
        // remain in state and the renderer would show both the error
        // banner AND a frozen progress bar.
        // Re-fetch the live current-model record AND sidecar status
        // here. A failed SWAP is the dangerous case: the main process's
        // `downloadModelLocked` evicts the previously-installed model
        // and clears `active-model.json` BEFORE issuing the network
        // fetch, so a network/checksum failure leaves the on-disk truth
        // as "no model installed" while the renderer's `state.current`
        // still holds the pre-swap record. Without this re-fetch the
        // user would see the old model card with Start/Delete buttons
        // that point at a file that no longer exists. The success path
        // already overwrites `state.current` with the download result;
        // mirroring that on failure restores the invariant
        // `state.current` == on-disk-truth on every settled boundary.
        const [liveCurrent, liveStatus] = await Promise.all([
          tessera.runtime.getCurrentModel("text").catch(() => null),
          tessera.model.status().catch(() => null),
        ]);
        setState((s) => ({
          ...s,
          busyModelId: null,
          progress: null,
          current: liveCurrent,
          status: liveStatus ?? s.status,
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    },
    [tessera],
  );

  const handleStart = useCallback(async () => {
    if (!tessera || !state.current) return;
    setState((s) => ({ ...s, error: null }));
    try {
      await tessera.model.start(state.current.path);
      const status = await tessera.model.status();
      setState((s) => ({ ...s, status }));
    } catch (err) {
      setState((s) => ({
        ...s,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }, [tessera, state.current]);

  const handleStop = useCallback(async () => {
    if (!tessera) return;
    try {
      await tessera.model.stop();
      const status = await tessera.model.status();
      setState((s) => ({ ...s, status }));
    } catch (err) {
      setState((s) => ({
        ...s,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }, [tessera]);

  const handleDelete = useCallback(async () => {
    if (!tessera || !state.current) return;
    // Activate the 5-second poll's `busyModelId` gate for the duration
    // of the delete. Without this the gate at the poll tick is
    // ineffective during delete: a poll tick whose `getCurrentModel()`
    // IPC resolves between the main-process unlink and the renderer's
    // final `setState({ current: null })` re-fetches the
    // still-on-disk record and "resurrects" the deleted model in the
    // UI for up to 5s. The same gate already guards `performDownload`;
    // the comment at the poll-tick gate (~line 152) explicitly names
    // delete as a case that must be covered.
    const deletingId = state.current.modelId;
    setState((s) => ({ ...s, busyModelId: deletingId, error: null }));
    try {
      // The sidecar holds an OS file handle on the active model. On
      // Windows that handle blocks the unlink with EPERM/EBUSY; on macOS
      // and Linux it leaves an orphaned process listening on port 8384.
      // Stop it before deletion. The main-process IPC handler also stops
      // it as a defense-in-depth safety net (direct IPC callers, other
      // windows), but doing it here keeps the local UI state
      // (`state.status`) in sync without an extra round-trip.
      if (state.status?.status === "running") {
        await tessera.model.stop();
        const status = await tessera.model.status();
        setState((s) => ({ ...s, status }));
      }
      await tessera.runtime.deleteModel("text");
      // Re-fetch BOTH `getCurrentModel("text")` AND `model.status()`
      // after the delete settles — not just on the running-before-
      // delete branch above. Two reasons:
      //
      //   1. Status: if the runtime was in any non-running state when
      //      delete fired ("stopped", "error", "starting", or a stale
      //      "running" that crashed externally), the truth on the
      //      main-process side after `deleteModel` is unambiguously
      //      "no model installed, nothing to run". Re-pulling
      //      `model.status()` keeps the UI honest instead of leaving
      //      a stale indicator next to the empty "no model" panel.
      //
      //   2. Current: re-fetching `getCurrentModel("text")` instead
      //      of hardcoding `current: null` matches the same
      //      "state.current == on-disk-truth on every settled
      //      boundary" invariant the error path (and `performDownload`
      //      both paths, and `ModelSlotPanel.handleDelete`) already
      //      maintains. A concurrent window could install a model
      //      between our `deleteModel` call and this re-fetch and we
      //      should pick that up here; hardcoding `null` would let
      //      the UI lie until the next 5s poll tick. The expected
      //      value is `null` (we just deleted), but reading from disk
      //      is the only way to guarantee that.
      const [liveCurrent, liveStatus] = await Promise.all([
        tessera.runtime.getCurrentModel("text").catch(() => null),
        tessera.model.status().catch(() => null),
      ]);
      setState((s) => ({
        ...s,
        busyModelId: null,
        current: liveCurrent,
        status: liveStatus ?? s.status,
      }));
    } catch (err) {
      // Mirror `performDownload`'s error path: re-fetch live current +
      // status so `state.current` matches on-disk truth on every
      // settled boundary. A partial-failure scenario (e.g.
      // `deleteCurrentModel` unlinked the file but threw before
      // clearing `active-model.json`, or vice-versa) would otherwise
      // leave the renderer holding a stale `state.current` record
      // pointing at a non-existent file, and the user would see
      // Start/Delete buttons that target a phantom model. The main
      // process's lock + `beforeMutation` hook makes partial failure
      // unlikely, but the asymmetry between the download and delete
      // error paths is the kind of latent footgun that bites during
      // future refactors. The success path already re-fetches; this
      // mirrors that for symmetry.
      const [liveCurrent, liveStatus] = await Promise.all([
        tessera.runtime.getCurrentModel("text").catch(() => null),
        tessera.model.status().catch(() => null),
      ]);
      setState((s) => ({
        ...s,
        busyModelId: null,
        current: liveCurrent,
        status: liveStatus ?? s.status,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }, [tessera, state.current, state.status]);

  if (!tessera) {
    return (
      <Card>
        <h3 style={{ marginBottom: "var(--spacing-md)" }}>Model Runtime</h3>
        <p style={{ color: "var(--color-text-secondary)" }}>
          Tessera bridge not available in this context.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <h3 style={{ marginBottom: "var(--spacing-md)" }}>Model Runtime</h3>

      {state.loading && <p>Detecting hardware…</p>}
      {state.error && (
        <p style={{ color: "var(--color-danger, #ef4444)" }}>{state.error}</p>
      )}

      {!state.loading && state.platform && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "max-content 1fr",
            columnGap: "var(--spacing-md)",
            rowGap: "var(--spacing-xs)",
            fontSize: "var(--font-size-sm)",
            marginBottom: "var(--spacing-md)",
          }}
          data-testid="model-runtime-platform"
        >
          <span>Platform:</span>
          <strong>{state.platform.platformLabel}</strong>
          <span>RAM:</span>
          <strong>
            {state.platform.totalRamGb.toFixed(1)} GB ({state.platform.tierLabel})
          </strong>
          <span>GPU:</span>
          <strong>{gpuLabel(state.platform.computeBackends)}</strong>
          <span>Preferred format:</span>
          <strong>
            {state.platform.preferredFormat === "mlx" ? "MLX" : "GGUF"}
          </strong>
        </div>
      )}

      {state.recommended && (
        <p
          style={{ marginBottom: "var(--spacing-md)" }}
          data-testid="model-runtime-recommended"
        >
          Recommended: <strong>{state.recommended.name}</strong> (
          {state.recommended.formatLabel}, ~{state.recommended.downloadSizeMb} MB)
        </p>
      )}

      {state.current ? (
        <div
          style={{ marginBottom: "var(--spacing-md)" }}
          data-testid="model-runtime-current"
        >
          <p>
            Installed: <strong>{state.current.modelId}</strong> (
            {state.current.downloadSizeMb} MB)
          </p>
          <p style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-secondary)" }}>
            {state.current.path}
          </p>
          <div style={{ display: "flex", gap: "var(--spacing-sm)", marginTop: "var(--spacing-sm)" }}>
            {state.status?.status === "running" ? (
              <Button onClick={handleStop}>Stop</Button>
            ) : (
              <Button onClick={handleStart}>Start</Button>
            )}
            <Button variant="secondary" onClick={handleDelete}>
              Delete model
            </Button>
          </div>
        </div>
      ) : (
        state.recommended && (
          <div style={{ marginBottom: "var(--spacing-md)" }}>
            <Button
              onClick={() => performDownload(state.recommended!.id)}
              disabled={state.busyModelId !== null}
            >
              {state.busyModelId === state.recommended.id
                ? "Downloading…"
                : "Download"}
            </Button>
          </div>
        )
      )}

      {/* Defense-in-depth against stale-progress-bar bugs: the bar is only
          shown while a download is in flight (`busyModelId !== null`). Even
          if a future code path forgets to null `state.progress` after a
          terminal state (success / failure / cancel), the UI cannot show a
          frozen bar next to an idle card. The catch blocks above still
          null `progress` explicitly so a subsequent `busyModelId` flip
          doesn't briefly resurrect a stale snapshot. */}
      {state.busyModelId && state.progress && (
        <div
          style={{ marginBottom: "var(--spacing-md)" }}
          data-testid="model-runtime-progress"
        >
          <p style={{ fontSize: "var(--font-size-sm)" }}>
            {state.progress.filename} — {state.progress.downloadedMb.toFixed(1)} /{" "}
            {state.progress.totalMb.toFixed(1)} MB ({state.progress.percent.toFixed(0)}%)
          </p>
          <progress value={state.progress.percent} max={100} style={{ width: "100%" }} />
        </div>
      )}

      <div>
        <button
          type="button"
          onClick={() => setState((s) => ({ ...s, showAll: !s.showAll }))}
          style={{
            background: "transparent",
            border: "none",
            color: "var(--color-primary, #7C3AED)",
            cursor: "pointer",
            padding: 0,
            fontSize: "var(--font-size-sm)",
          }}
          aria-expanded={state.showAll}
        >
          {state.showAll ? "Hide" : "Show"} all available models
        </button>
        {state.showAll && (
          <ul style={{ listStyle: "none", padding: 0, marginTop: "var(--spacing-sm)" }}>
            {state.models.map((m) => {
              const isCurrent = state.current?.modelId === m.id;
              const isBusy = state.busyModelId === m.id;
              return (
                <li
                  key={m.id}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "var(--spacing-xs) 0",
                    borderBottom: "1px solid var(--color-border, #e5e7eb)",
                  }}
                >
                  <span>
                    <strong>{m.name}</strong> · {m.parameters} · {m.formatLabel} ·{" "}
                    {m.downloadSizeMb} MB
                  </span>
                  {isCurrent ? (
                    <em style={{ fontSize: "var(--font-size-xs)" }}>installed</em>
                  ) : (
                    <Button
                      variant="secondary"
                      onClick={() => performDownload(m.id)}
                      disabled={state.busyModelId !== null}
                    >
                      {isBusy
                        ? "Working…"
                        : state.current
                          ? "Swap"
                          : "Download"}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Card>
  );
}
