import Button from "./Button";
import { useActiveGeneration } from "../hooks/useActiveGeneration";

/**
 * "Stop generating" button that:
 *  - Renders only while the model is streaming (subscribed to the
 *    module-scope `useActiveGeneration` store)
 *  - Issues `model:cancelJob` IPC on click. The main-process
 *    handler aborts the shared `AbortController` that both the
 *    local sidecar streaming path and the external-provider
 *    streaming path register against, so this single button works
 *    for both adapters.
 *  - Disappears immediately on click (optimistic) so the user
 *    sees responsive feedback even if the upstream provider takes
 *    a moment to flush its final SSE chunk.
 *
 * Mounted in `ArtifactEditorPage` header. Self-mounting from a
 * single root would also be reasonable, but the editor page is
 * the primary surface where a user spends time waiting on
 * generation today, so it's the highest-value placement.
 *
 * Accessibility: includes an explicit aria-label so screen readers
 * announce "Stop generating" even when the visible text is
 * truncated by narrow layouts.
 */
export default function StopGenerationButton() {
  const { isActive, cancel } = useActiveGeneration();
  if (!isActive) return null;
  return (
    <Button
      variant="secondary"
      onClick={() => {
        void cancel();
      }}
      aria-label="Stop generating"
      data-testid="stop-generation-button"
    >
      Stop generating
    </Button>
  );
}
