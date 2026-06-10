import type { ResourceMode } from "../types/ipc";

/**
 * Human labels for the LW-2 resource modes. Single source of truth so
 * the Settings → Performance toggle (`SettingsPage`) and the read-only
 * mode row in the Resource-usage dashboard (`ResourceUsageCard`) can't
 * drift apart.
 */
export const RESOURCE_MODE_LABELS: Record<ResourceMode, string> = {
  lightweight: "Lightweight (recommended)",
  performance: "Performance",
};
