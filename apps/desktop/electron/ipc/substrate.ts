/**
 * IPC handlers for the `substrate:*` channels — the renderer-facing
 * surface of the additive knowledge substrate (Session 1).
 *
 * Every channel validates its scalar inputs with the helpers in
 * `./validate.ts` (the substrate takes only ids / scope labels /
 * a node cap — no structured object payloads, so no zod schema is
 * needed) and then delegates to the corresponding `bridge*` N-API
 * function on the native bridge. The bridge surfaces substrate errors
 * (invalid UUID, memory-not-found, store failures) as rejected
 * promises, which propagate to the renderer unchanged.
 *
 * These channels are FOUNDATIONAL: Session 3 (memories / concept-graph
 * UI) and Session 6 (search) consume them. Channel names and payload
 * shapes are part of the cross-session contract — see `SubstrateApi`
 * in `apps/desktop/shared/types.ts`.
 */
import { getBridge } from "../appState";
import { assertId, assertNumber, assertOptionalString } from "./validate";
import { idempotentHandle } from "./register";

/** Scope labels are short ("default") or a 36-char UUID. */
const MAX_SCOPE_LEN = 128;

function requireBridge() {
  const bridge = getBridge();
  if (!bridge) throw new Error("Native bridge not available");
  return bridge;
}

export function registerSubstrateHandlers(): void {
  idempotentHandle("substrate:extractObservations", async (_event, sourceId) => {
    const id = assertId(sourceId, "sourceId");
    return requireBridge().bridgeExtractObservations(id);
  });

  idempotentHandle("substrate:getMemories", async (_event, scope) => {
    const s = assertOptionalString(scope, "scope", { maxLen: MAX_SCOPE_LEN });
    return requireBridge().bridgeGetMemories(s);
  });

  idempotentHandle("substrate:pinMemory", async (_event, id) => {
    const memId = assertId(id, "id");
    return requireBridge().bridgePinMemory(memId);
  });

  idempotentHandle("substrate:unpinMemory", async (_event, id) => {
    const memId = assertId(id, "id");
    return requireBridge().bridgeUnpinMemory(memId);
  });

  idempotentHandle("substrate:forgetMemory", async (_event, id) => {
    const memId = assertId(id, "id");
    requireBridge().bridgeForgetMemory(memId);
  });

  idempotentHandle(
    "substrate:getConceptGraph",
    async (_event, scope, maxNodes) => {
      const s = assertOptionalString(scope, "scope", { maxLen: MAX_SCOPE_LEN });
      const cap =
        maxNodes === null || maxNodes === undefined
          ? null
          : assertNumber(maxNodes, "maxNodes", {
              min: 1,
              max: 100_000,
              integer: true,
            });
      return requireBridge().bridgeGetConceptGraph(s, cap);
    },
  );

  idempotentHandle("substrate:runDecaySweep", async () => {
    return requireBridge().bridgeRunDecaySweep();
  });

  idempotentHandle("substrate:triggerSynthesis", async (_event, scope) => {
    const s = assertOptionalString(scope, "scope", { maxLen: MAX_SCOPE_LEN });
    return requireBridge().bridgeTriggerSynthesis(s);
  });
}
