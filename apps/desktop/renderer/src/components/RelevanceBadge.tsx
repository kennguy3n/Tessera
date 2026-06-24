/**
 * RelevanceBadge — renders a search hit's relevance score (RRF-bounded
 * to `(0, 1]` by `crates/tessera_sources/src/hybrid.rs`) as a tier
 * label + colored pill.
 *
 * Tiers:
 *   - High (>= 0.7)  → green
 *   - Medium (0.3 ≤ s < 0.7) → amber
 *   - Low (< 0.3)    → red-tinted neutral
 *
 * The tooltip always reads "Relevance: {percent}% — {tier}" so screen
 * readers and hover users get the same explanation regardless of
 * where the badge is placed (citation search, replace dialog, future
 * inline citation hover cards).
 */
import type { CSSProperties } from "react";
import { classifyRelevance, type RelevanceTier } from "./relevanceBadgeHelpers";

export type { RelevanceTier };

export interface RelevanceBadgeProps {
  /** Score in `(0, 1]` as returned by hybrid search. */
  score: number;
  /**
   * `pill` (default) — compact colored chip; suitable inside search
   *                    hit rows.
   * `inline` — text-only with the colored dot prefix; suitable for
   *           dense lists where a full pill would clutter the row.
   */
  variant?: "pill" | "inline";
  /** Optional style passthrough for callers that need to position. */
  style?: CSSProperties;
}

const TIER_LABEL: Record<RelevanceTier, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

// CSS custom-property-based colors so the badge tracks the user's
// theme automatically. The fallbacks are the canonical Tessera
// palette so the badge is still legible if the theme stylesheet
// hasn't loaded yet (vitest environments, first-paint races).
const TIER_COLORS: Record<RelevanceTier, { fg: string; bg: string }> = {
  high: {
    fg: "var(--color-relevance-high-fg, #15803d)",
    bg: "var(--color-relevance-high-bg, rgba(34, 197, 94, 0.16))",
  },
  medium: {
    fg: "var(--color-relevance-medium-fg, #b45309)",
    bg: "var(--color-relevance-medium-bg, rgba(245, 158, 11, 0.16))",
  },
  low: {
    fg: "var(--color-relevance-low-fg, #b91c1c)",
    bg: "var(--color-relevance-low-bg, rgba(239, 68, 68, 0.14))",
  },
};

function formatPercent(score: number): string {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(score) ? score : 0));
  return `${Math.round(clamped * 100)}%`;
}

export default function RelevanceBadge({
  score,
  variant = "pill",
  style,
}: RelevanceBadgeProps) {
  const tier = classifyRelevance(score);
  const colors = TIER_COLORS[tier];
  const percent = formatPercent(score);
  const tooltip = `Relevance: ${percent} — ${TIER_LABEL[tier]}`;

  if (variant === "inline") {
    return (
      <span
        title={tooltip}
        aria-label={tooltip}
        data-testid="relevance-badge"
        data-tier={tier}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "var(--spacing-xs)",
          fontSize: "var(--font-size-xs)",
          fontVariantNumeric: "tabular-nums",
          color: "var(--color-text-secondary)",
          ...style,
        }}
      >
        <span
          aria-hidden="true"
          style={{
            display: "inline-block",
            width: "0.5em",
            height: "0.5em",
            borderRadius: "50%",
            backgroundColor: colors.fg,
          }}
        />
        <span>Relevance {percent}</span>
      </span>
    );
  }

  return (
    <span
      title={tooltip}
      aria-label={tooltip}
      data-testid="relevance-badge"
      data-tier={tier}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--spacing-xs)",
        padding: "0.125rem 0.5rem",
        borderRadius: "999px",
        fontSize: "var(--font-size-xs)",
        fontWeight: 600,
        fontVariantNumeric: "tabular-nums",
        color: colors.fg,
        backgroundColor: colors.bg,
        ...style,
      }}
    >
      <span>Relevance {percent}</span>
    </span>
  );
}
