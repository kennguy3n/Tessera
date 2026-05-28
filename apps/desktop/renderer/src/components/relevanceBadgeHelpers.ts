/**
 * Tier classification helper + type used by `RelevanceBadge`.
 *
 * Lives in a sibling module so React Fast Refresh can preserve
 * component state across HMR edits on the badge file. Several
 * tests pin the threshold semantics independently of the
 * component render (`relevanceBadge.test.tsx`), so the function
 * is exported here as the canonical home.
 */
export type RelevanceTier = "high" | "medium" | "low";

const HIGH_THRESHOLD = 0.7;
const MEDIUM_THRESHOLD = 0.3;

export function classifyRelevance(score: number): RelevanceTier {
  if (!Number.isFinite(score)) return "low";
  if (score >= HIGH_THRESHOLD) return "high";
  if (score >= MEDIUM_THRESHOLD) return "medium";
  return "low";
}
