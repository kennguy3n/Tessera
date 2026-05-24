import { useCallback, useEffect, useState } from "react";

/**
 * Global "is the model currently streaming?" state, exposed to any
 * component that needs to surface a cancel control or progress
 * indicator.
 *
 * The state is module-scoped (not React-Context-scoped) for two
 * reasons:
 *
 *  1. The `model:token` IPC channel is broadcast — every renderer
 *     mount that subscribes receives every token event regardless
 *     of which mount invoked `model:generate`. A module-scope
 *     subscriber list is the natural fit for that one-to-many
 *     dispatch and avoids forcing every page that consumes the
 *     state to be wrapped in a `<GenerationProvider>`.
 *
 *  2. The IPC subscription is set up exactly ONCE per renderer
 *     load — adding a second subscription per consuming component
 *     would leak `model:token` listeners on every page
 *     navigation. The module-scope listener is registered on
 *     first use, refcounted, and torn down when the last hook
 *     consumer unmounts.
 *
 * State machine:
 *  - idle: no in-flight generation
 *  - active: at least one chunk with `done: false` has been
 *    observed, and no `done: true` has been seen since
 *  - The first `done: true` chunk flips back to idle. Subsequent
 *    `done: true` chunks (which the IPC layer guarantees never to
 *    emit, but we defend anyway) are no-ops.
 *
 * The hook ALSO exposes `notifyGenerationStarted()` so callers
 * that invoke `model:generate` can mark the state as active
 * BEFORE the first token arrives (network latency, queue-ahead).
 * Without this hint the Stop button would be invisible for the
 * first 100\u2013500ms of every stream, which is the exact window
 * a user is most likely to want to cancel.
 */

let isActive = false;
const subscribers = new Set<(active: boolean) => void>();
let unsubscribeFromIpc: (() => void) | null = null;

function notifyAll() {
  for (const s of subscribers) {
    try {
      s(isActive);
    } catch {
      // A misbehaving subscriber must not break the broadcast for
      // the rest. The renderer has no logger sink here; we
      // intentionally swallow.
    }
  }
}

function ensureIpcSubscription() {
  if (unsubscribeFromIpc !== null) return;
  if (typeof window === "undefined") return;
  const api = window.tessera;
  if (!api?.model?.onToken) return;
  unsubscribeFromIpc = api.model.onToken((chunk) => {
    if (chunk.done) {
      if (isActive) {
        isActive = false;
        notifyAll();
      }
      return;
    }
    if (!isActive) {
      isActive = true;
      notifyAll();
    }
  });
}

function teardownIpcSubscription() {
  if (unsubscribeFromIpc) {
    unsubscribeFromIpc();
    unsubscribeFromIpc = null;
  }
}

/**
 * Mark the active-generation state as TRUE synchronously.
 *
 * Call this immediately before invoking
 * `window.tessera.model.generate(...)`. The hook will flip back to
 * idle on the first `done: true` token IPC event. This is the only
 * way to make the Stop button visible during the pre-first-token
 * window — relying purely on token events leaves a visibility gap
 * of however long the upstream provider takes to flush its first
 * chunk, which on Anthropic + OpenAI is often 1\u20132 seconds.
 *
 * ## Current production callers: none (intentional)
 *
 * that no production
 * code currently calls this function. That is by design:
 *
 *   - The `model:generate` IPC channel (`electron/ipc/model.ts`)
 *     is wired end-to-end and tested, but no renderer page yet
 *     invokes it. Today's renderer drives generation through the
 *     synchronous `artifacts.generateFromTemplate` bridge call,
 *     which runs through `inference_router` and never emits the
 *     `model:token` events this hook subscribes to (see the
 *     comment in `pages/CreatePage.tsx` at the `bridgeGenerate`
 *     callsite — the previous attempt to subscribe to
 *     `model:token` for that path was removed as dead code).
 *
 *   - The streaming `model:generate` path is reserved for an
 *     upcoming surface (chat-style interaction with the local
 *     sidecar / external provider) that has not yet shipped. When
 *     that surface lands, the renderer code that calls
 *     `window.tessera.model.generate(...)` must call
 *     `notifyGenerationStarted()` immediately before the IPC
 *     invoke. Forgetting to do so re-introduces the 1\u20132 s
 *     pre-first-token visibility gap on the Stop button — which
 *     is the exact bug this hook was designed to close.
 *
 * The function stays exported (rather than being inlined into a
 * future caller's file) for three reasons:
 *
 *   1. The module-scope `isActive` / `notifyAll` plumbing is
 *      already coupled to the IPC-token subscription set up at
 *      module load. Putting the start hint anywhere else would
 *      either reach into module-private state (worse coupling)
 *      or recreate the plumbing (duplication).
 *
 *   2. The contract is pinned by tests in
 *      `stopGenerationButton.test.tsx` (the call-before-IPC
 *      ordering must produce a synchronous true \u2192 false \u2192 true
 *      cycle around the first `done: false` token). If a future
 *      contributor refactors this function out of existence,
 *      those tests will fail loudly, which is the desired
 *      regression-detection signal.
 *
 *   3. Removing the export would force the future caller to
 *      reach into the hook's internals or duplicate the
 *      subscriber-notification logic. Keeping a small, named,
 *      well-documented export is the lower-coupling choice.
 *
 * If a future audit revisits this and the streaming
 * `model:generate` surface has been removed entirely (not just
 * unshipped), THEN this export becomes genuinely dead and should
 * be removed alongside the IPC channel itself — but that's a
 * paired removal, not an isolated cleanup.
 */
export function notifyGenerationStarted(): void {
  if (!isActive) {
    isActive = true;
    notifyAll();
  }
}

/**
 * React hook returning `{ isActive, cancel }`.
 *
 * `cancel()` is a stable callback that invokes the IPC
 * `model:cancelJob` channel and is safe to call when no
 * generation is active (the main-process handler is a no-op).
 *
 * Multiple components can call this hook simultaneously; they all
 * share one IPC subscription and observe the same `isActive`
 * value.
 */
export function useActiveGeneration(): {
  isActive: boolean;
  cancel: () => Promise<void>;
} {
  const [active, setActive] = useState<boolean>(isActive);

  useEffect(() => {
    ensureIpcSubscription();
    subscribers.add(setActive);
    // Sync the just-mounted consumer with the current value in
    // case it joined after a token arrived.
    setActive(isActive);
    return () => {
      subscribers.delete(setActive);
      if (subscribers.size === 0) {
        teardownIpcSubscription();
        // Reset the in-memory flag so a future remount starts
        // from a clean baseline. The IPC handler in the main
        // process is independent and stays consistent.
        isActive = false;
      }
    };
  }, []);

  const cancel = useCallback(async () => {
    const api = typeof window !== "undefined" ? window.tessera : undefined;
    if (!api?.model?.cancelJob) return;
    try {
      await api.model.cancelJob();
    } catch {
      // The main-process cancel handler is best-effort; we don't
      // surface its errors to the renderer. Any in-flight stream
      // will still emit `done: true` (clean cancellation) or fail
      // with a thrown error from the originating generate() call.
    }
    // Flip locally even if the IPC call rejected, so the Stop
    // button hides immediately and matches user intent. The
    // subsequent `done: true` will be a no-op (already idle).
    if (isActive) {
      isActive = false;
      notifyAll();
    }
  }, []);

  return { isActive: active, cancel };
}

/**
 * Test-only reset hook. Clears the module-scope subscriber list
 * and IPC subscription so a vitest mount can start from a clean
 * slate. NOT exported from the package barrel; tests import the
 * file directly.
 */
export function _resetActiveGenerationForTests(): void {
  isActive = false;
  subscribers.clear();
  teardownIpcSubscription();
}
