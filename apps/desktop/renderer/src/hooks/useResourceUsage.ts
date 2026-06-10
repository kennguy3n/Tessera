import { useEffect, useState } from "react";
import type { ResourceUsage } from "../types/ipc";

/**
 * LW-12: polls `resources:getUsage` every `intervalMs` while `enabled`
 * is true, returning the most recent snapshot (or `null` until the
 * first response). Drives the Settings → Performance "Resource usage"
 * card.
 *
 * Re-scheduling uses a recursive `setTimeout` rather than `setInterval`
 * so a slow IPC round-trip can never let calls stack up — the next
 * poll is only armed after the previous one settles. The `enabled`
 * flag lets the caller stop polling when the card is off-screen (the
 * Performance card mounts/unmounts with the Settings route) so a
 * minimised, idle app isn't woken every few seconds just to refresh a
 * panel nobody is looking at — itself a small contribution to the
 * "zero background cost when idle" goal the dashboard reports on.
 */
export function useResourceUsage(
  enabled = true,
  intervalMs = 2000,
): ResourceUsage | null {
  const [snap, setSnap] = useState<ResourceUsage | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled) return;
      try {
        const next = await window.tessera.resources.getUsage();
        if (cancelled) return;
        setSnap(next);
      } catch {
        // Swallow and keep polling — the bridge may not be initialised
        // yet (the renderer paints before bridge-init completes, LW-8),
        // and a transparency panel must never surface a hard error.
      }
      if (!cancelled) {
        timer = setTimeout(tick, intervalMs);
      }
    };

    tick();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [enabled, intervalMs]);

  return snap;
}
