/**
 * `ModelSlotPanel` — install / recommend / delete UI for ONE
 * model capability slot (currently `"vision"` or `"imagegen"`).
 *
 * Why this isn't `ModelRuntimeCard`
 * ---------------------------------
 * `ModelRuntimeCard` manages the TEXT slot, which is structurally
 * special:
 *
 *   1. The text sidecar has explicit Start / Stop controls. The
 *      vision and imagegen sidecars start LAZILY on the first
 *      `vision:describe` / `imagegen:generate` call — there is no
 *      user-facing handle to "start" them ahead of time, and pre-
 *      starting them would just waste RAM (vision: ~3 GB,
 *      imagegen: ~6 GB) on hosts where the user never invokes the
 *      feature. The slot panel therefore omits the Start/Stop
 *      buttons entirely.
 *
 *   2. `tessera.model.status()` only reports the text sidecar's
 *      state. Re-using it here would either show stale "text"
 *      data in a vision slot or require a parallel
 *      `tessera.vision.status` / `tessera.imagegen.status` IPC —
 *      neither of which is shipping in this PR. The slot panel
 *      drops the status display in favour of just "Installed: X"
 *      / "Not installed".
 *
 *   3. The 5s poll in `ModelRuntimeCard` re-fetches BOTH the
 *      sidecar status AND the installed-model record. The slot
 *      panel polls only the installed-model record (cheap stat)
 *      because there is no sidecar status to render.
 *
 * Everything else — `listModels(capability)`, `recommendModel(
 * capability)`, `getCurrentModel(capability)`, `deleteModel(
 * capability)`, the `onDownloadProgress` filtering, the busyModelId
 * gate against poll-overwriting optimistic state, the "Show all
 * available models" disclosure — is structurally identical to
 * `ModelRuntimeCard`'s text path, just scoped to one capability via
 * the per-call IPC argument.
 *
 * The component is intentionally a SIBLING of `ModelRuntimeCard`,
 * not a replacement. Settings → Models now renders three sections:
 *
 *   <ModelRuntimeCard />            // text slot + platform info
 *   <ModelSlotPanel capability="vision" .../>
 *   <ModelSlotPanel capability="imagegen" .../>
 *
 * This preserves every existing test in `components.test.tsx`
 * (which exercises the text path) and adds new coverage for the
 * vision/imagegen paths in `modelSlotPanel.test.tsx`.
 */
import { useCallback, useEffect, useState } from "react";
import Card from "./Card";
import Button from "./Button";
import type {
  InstalledModelRecord,
  ModelCapability,
  ModelDownloadProgress,
  ResolvedModel,
} from "../types/ipc";

export interface ModelSlotPanelProps {
  /**
   * Which capability slot this panel manages. The IPC layer
   * already routes per-capability — see
   * `tessera.runtime.{listModels,recommendModel,getCurrentModel,
   * deleteModel}` in `apps/desktop/shared/types.ts` — so the
   * panel just threads this single value through every call.
   */
  capability: Exclude<ModelCapability, "text">;
  /**
   * Section heading rendered at the top of the card (e.g.
   * "Vision model" / "Image-generation model"). Pulled in from
   * the parent so the wording can match the surrounding Settings
   * page copy without baking it into the component.
   */
  title: string;
  /**
   * One-paragraph blurb explaining what this slot is for. Shown
   * below the heading. Empty string is allowed; falsy → not
   * rendered. The Settings page passes a short pragmatic
   * description so the user understands what installing a model
   * here actually enables.
   */
  description?: string;
  /**
   * Prefix for `data-testid` attributes — e.g. `"vision-slot"`
   * yields `"vision-slot-recommended"`, `"vision-slot-current"`,
   * `"vision-slot-progress"`, etc. Keeping the prefix as a prop
   * (rather than deriving from `capability`) lets the tests
   * select specific panels in pages that mount more than one,
   * and matches the existing `model-runtime-*` naming for the
   * text-slot card.
   */
  testIdPrefix: string;
  /**
   * Optional override used by tests; falls back to
   * `window.tessera`. Mirrors `ModelRuntimeCardProps.api` so
   * test setup is identical between the two cards.
   */
  api?: Window["tessera"];
}

interface State {
  loading: boolean;
  error: string | null;
  models: ResolvedModel[];
  recommended: ResolvedModel | null;
  current: InstalledModelRecord | null;
  progress: ModelDownloadProgress | null;
  busyModelId: string | null;
  showAll: boolean;
}

const initialState: State = {
  loading: true,
  error: null,
  models: [],
  recommended: null,
  current: null,
  progress: null,
  busyModelId: null,
  showAll: false,
};

export default function ModelSlotPanel({
  capability,
  title,
  description,
  testIdPrefix,
  api,
}: ModelSlotPanelProps) {
  const tessera =
    api ?? (typeof window !== "undefined" ? window.tessera : undefined);
  const [state, setState] = useState<State>(initialState);

  const refresh = useCallback(async () => {
    if (!tessera) return;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const [models, recommended, current] = await Promise.all([
        tessera.runtime.listModels(capability),
        tessera.runtime.recommendModel(capability),
        tessera.runtime.getCurrentModel(capability),
      ]);
      setState((s) => ({
        ...s,
        loading: false,
        models,
        recommended,
        current,
      }));
    } catch (err) {
      setState((s) => ({
        ...s,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }, [tessera, capability]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Subscribe to download-progress events, but FILTER by capability so
  // a concurrent text-slot download doesn't paint into this panel's
  // progress bar. `ModelDownloadProgress.capability` was added in
  // Block A precisely so the multi-slot Settings UI could route per-
  // slot events to the matching panel.
  useEffect(() => {
    if (!tessera) return;
    return tessera.runtime.onDownloadProgress(
      (p: ModelDownloadProgress) => {
        if (p.capability !== capability) return;
        setState((s) => ({ ...s, progress: p }));
      },
    );
  }, [tessera, capability]);

  // 5s poll for the installed-model record so an out-of-band
  // deletion (e.g. the user runs `rm <userData>/models/...`) or a
  // download completing in another window shows up here within a
  // refresh window — matching the cadence used by
  // `ModelRuntimeCard` for the text slot. We deliberately do NOT
  // re-poll the EXPENSIVE values (`listModels`, `recommendModel`)
  // because those are functions of the shipped manifest and don't
  // change at runtime.
  //
  // The `busyModelId !== null` gate is critical: without it, a
  // poll tick landing in the window between `handleDelete` nulling
  // `current` optimistically and the main process finishing the
  // unlink would re-fetch the still-on-disk record and "resurrect"
  // it in the UI for up to 5s. The functional setState reads
  // `s.busyModelId` at commit time, so the gate is race-free
  // against the user-action handlers.
  useEffect(() => {
    if (!tessera) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const current = await tessera.runtime.getCurrentModel(capability);
        if (cancelled) return;
        setState((s) => {
          if (s.busyModelId !== null) return s;
          return { ...s, current };
        });
      } catch {
        // Swallow — a transient IPC blip shouldn't blank out the
        // record the user just downloaded. The next successful
        // tick will re-sync.
      }
    };
    const id = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [tessera, capability]);

  const performDownload = useCallback(
    async (modelId: string) => {
      if (!tessera) return;
      setState((s) => ({
        ...s,
        busyModelId: modelId,
        error: null,
        progress: null,
      }));
      try {
        // `runtime.downloadModel(modelId)` routes by the model's
        // declared capability — the main-process handler reads it
        // off the resolved manifest entry and writes into the
        // correct active-model-<capability>.json slot. The
        // renderer just hands off the modelId.
        const record = await tessera.runtime.downloadModel(modelId);
        // Re-fetch the live record so a SWAP path (downloadModel
        // evicts the previous entry before fetching) lands the
        // canonical record in state, not just whatever the IPC
        // returned synchronously.
        const liveCurrent = await tessera.runtime
          .getCurrentModel(capability)
          .catch(() => null);
        setState((s) => ({
          ...s,
          busyModelId: null,
          current: liveCurrent ?? record,
          progress: null,
        }));
      } catch (err) {
        // The main process's `downloadModelLocked` evicts the
        // previously-installed model from the per-capability
        // active-model file BEFORE issuing the network fetch, so
        // a network / checksum failure on a SWAP leaves the
        // on-disk truth as "no model installed" while the
        // renderer's `state.current` still holds the pre-swap
        // record. Re-fetch the live record so `state.current`
        // matches on-disk-truth on every settled boundary,
        // matching the same invariant `ModelRuntimeCard`
        // maintains for the text slot.
        const liveCurrent = await tessera.runtime
          .getCurrentModel(capability)
          .catch(() => null);
        setState((s) => ({
          ...s,
          busyModelId: null,
          progress: null,
          current: liveCurrent,
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    },
    [tessera, capability],
  );

  const handleDelete = useCallback(async () => {
    if (!tessera) return;
    // Defense-in-depth: the Delete button is only rendered when
    // `state.current` is truthy (see the conditional in the
    // installed-model section), so in practice this branch is
    // unreachable. We still gate the IPC on `state.current` to
    // match the pattern `ModelRuntimeCard.handleDelete` uses for
    // the text slot — that way a future refactor that changes
    // HOW the Delete button is gated (e.g. exposing it via a
    // context-menu or keyboard shortcut that's not synchronised
    // with the button's rendering condition) can't accidentally
    // bypass this guard and issue a deleteModel call against an
    // empty slot.
    if (!state.current) return;
    setState((s) => ({ ...s, error: null, busyModelId: "__delete__" }));
    try {
      await tessera.runtime.deleteModel(capability);
      const liveCurrent = await tessera.runtime
        .getCurrentModel(capability)
        .catch(() => null);
      setState((s) => ({
        ...s,
        busyModelId: null,
        current: liveCurrent,
      }));
    } catch (err) {
      // On a delete failure the on-disk state is uncertain — the
      // file may or may not have been unlinked. Re-fetch the
      // truth before settling so the user sees what's actually
      // there.
      const liveCurrent = await tessera.runtime
        .getCurrentModel(capability)
        .catch(() => null);
      setState((s) => ({
        ...s,
        busyModelId: null,
        current: liveCurrent,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }, [tessera, capability, state.current]);

  if (!tessera) {
    // Defensive: outside an Electron renderer (e.g. Storybook,
    // SSR), render a neutral placeholder rather than throwing.
    return (
      <Card>
        <h3 style={{ marginBottom: "var(--spacing-md)" }}>{title}</h3>
        <p>Bridge unavailable.</p>
      </Card>
    );
  }

  return (
    <Card>
      <h3
        style={{ marginBottom: "var(--spacing-md)" }}
        data-testid={`${testIdPrefix}-title`}
      >
        {title}
      </h3>

      {description && (
        <p
          style={{
            marginBottom: "var(--spacing-md)",
            color: "var(--color-text-secondary)",
            fontSize: "var(--font-size-sm)",
          }}
        >
          {description}
        </p>
      )}

      {state.loading && <p>Loading…</p>}
      {state.error && (
        <p
          style={{ color: "var(--color-danger, #ef4444)" }}
          data-testid={`${testIdPrefix}-error`}
          role="alert"
        >
          {state.error}
        </p>
      )}

      {state.recommended && (
        <p
          style={{ marginBottom: "var(--spacing-md)" }}
          data-testid={`${testIdPrefix}-recommended`}
        >
          Recommended: <strong>{state.recommended.name}</strong> (
          {state.recommended.formatLabel}, ~{state.recommended.downloadSizeMb}{" "}
          MB)
        </p>
      )}

      {state.current ? (
        <div
          style={{ marginBottom: "var(--spacing-md)" }}
          data-testid={`${testIdPrefix}-current`}
        >
          <p>
            Installed: <strong>{state.current.modelId}</strong> (
            {state.current.downloadSizeMb} MB)
          </p>
          <p
            style={{
              fontSize: "var(--font-size-xs)",
              color: "var(--color-text-secondary)",
            }}
          >
            {state.current.path}
          </p>
          {state.current.mmprojPath && (
            <p
              style={{
                fontSize: "var(--font-size-xs)",
                color: "var(--color-text-secondary)",
              }}
              data-testid={`${testIdPrefix}-mmproj`}
            >
              Projector: {state.current.mmprojPath}
            </p>
          )}
          <div
            style={{
              display: "flex",
              gap: "var(--spacing-sm)",
              marginTop: "var(--spacing-sm)",
            }}
          >
            <Button
              variant="secondary"
              onClick={handleDelete}
              disabled={state.busyModelId !== null}
              data-testid={`${testIdPrefix}-delete`}
            >
              {state.busyModelId === "__delete__" ? "Deleting…" : "Delete model"}
            </Button>
          </div>
        </div>
      ) : (
        state.recommended && (
          <div style={{ marginBottom: "var(--spacing-md)" }}>
            <Button
              onClick={() => performDownload(state.recommended!.id)}
              disabled={state.busyModelId !== null}
              data-testid={`${testIdPrefix}-download`}
            >
              {state.busyModelId === state.recommended.id
                ? "Downloading…"
                : "Download"}
            </Button>
          </div>
        )
      )}

      {/* Same defense-in-depth as ModelRuntimeCard: the bar is only
          shown while a download is in flight (`busyModelId !== null` and
          NOT the synthetic delete sentinel). If a future code path
          forgets to null `state.progress`, the UI still cannot show a
          frozen bar on an idle panel. */}
      {state.busyModelId &&
        state.busyModelId !== "__delete__" &&
        state.progress && (
          <div
            style={{ marginBottom: "var(--spacing-md)" }}
            data-testid={`${testIdPrefix}-progress`}
          >
            <p style={{ fontSize: "var(--font-size-sm)" }}>
              {state.progress.filename} —{" "}
              {state.progress.downloadedMb.toFixed(1)} /{" "}
              {state.progress.totalMb.toFixed(1)} MB (
              {state.progress.percent.toFixed(0)}%)
            </p>
            <progress
              value={state.progress.percent}
              max={100}
              style={{ width: "100%" }}
            />
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
          data-testid={`${testIdPrefix}-toggle-all`}
        >
          {state.showAll ? "Hide" : "Show"} all available models
        </button>
        {state.showAll && (
          <ul
            style={{
              listStyle: "none",
              padding: 0,
              marginTop: "var(--spacing-sm)",
            }}
            data-testid={`${testIdPrefix}-all`}
          >
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
                    <strong>{m.name}</strong> · {m.parameters} ·{" "}
                    {m.formatLabel} · {m.downloadSizeMb} MB
                  </span>
                  {isCurrent ? (
                    <em style={{ fontSize: "var(--font-size-xs)" }}>
                      installed
                    </em>
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
