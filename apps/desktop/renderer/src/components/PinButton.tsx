/**
 * pin / favorite toggle button.
 *
 * Renders a star icon that reflects the artifact's pinned state.
 * Clicking flips the state via `usePinnedArtifacts.togglePin` and
 * the resulting IPC roundtrip refreshes every consumer through
 * the shared `useSettings` state — no event prop drilling.
 *
 * Kept as a small focused component so the artifact editor header,
 * the home page artifact card, and the command palette can all
 * share it without duplicating the toggle logic.
 */

import { Star } from "lucide-react";
import { usePinnedArtifacts } from "../hooks/usePinnedArtifacts";
import { useCspNonce } from "../utils/cspNonce";

interface PinButtonProps {
  artifactId: string;
  /**
   * When false, renders an icon-only button (used in compact
   * surfaces like the home-page card hover state). When true,
   * renders icon + "Pin" / "Pinned" label.
   */
  withLabel?: boolean;
}

export default function PinButton({
  artifactId,
  withLabel = false,
}: PinButtonProps) {
  const cspNonce = useCspNonce();
  const { isPinned, togglePin } = usePinnedArtifacts();
  const pinned = isPinned(artifactId);

  return (
    <button
      type="button"
      className={`pin-button ${pinned ? "pin-button-active" : ""}`}
      aria-pressed={pinned}
      aria-label={pinned ? "Unpin artifact" : "Pin artifact"}
      title={pinned ? "Unpin artifact" : "Pin artifact"}
      onClick={() => {
        void togglePin(artifactId);
      }}
      data-testid="pin-button"
    >
      <Star size={16} fill={pinned ? "currentColor" : "none"} />
      {withLabel && <span>{pinned ? "Pinned" : "Pin"}</span>}
      <style nonce={cspNonce}>{`
        .pin-button {
          display: inline-flex;
          align-items: center;
          gap: var(--spacing-xs);
          padding: var(--spacing-xs) var(--spacing-sm);
          background: transparent;
          border: 1px solid var(--color-border);
          border-radius: var(--radius-sm);
          color: var(--color-text-secondary);
          font-size: var(--font-size-sm);
          cursor: pointer;
        }
        .pin-button:hover {
          color: var(--color-text-body);
          border-color: var(--color-primary, currentColor);
        }
        .pin-button-active {
          color: var(--color-warning, #b58105);
          border-color: var(--color-warning, #b58105);
        }
      `}</style>
    </button>
  );
}
