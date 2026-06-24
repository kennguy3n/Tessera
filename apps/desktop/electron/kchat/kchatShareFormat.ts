/**
 * Share-to-channel format/delivery selection (Session 8 Task 4).
 *
 * The original `kchat:shareArtifact` always exported the artifact
 * and uploaded the bytes as a file. Task 4 broadens this to two
 * orthogonal axes:
 *
 *   - **format** — `markdown | html | pdf | docx | json`. DOCX and
 *     PDF produce a binary attachment; the others a text file.
 *   - **delivery** — how the artifact reaches the channel:
 *       - `attachment`: export the bytes and upload them (the
 *         original behaviour; now also covers DOCX / PDF).
 *       - `deeplink`: skip the export entirely and post a
 *         `tessera://artifact/<id>` message so a teammate running
 *         Tessera can open the live artifact instead of a frozen
 *         copy.
 *
 * This module is the pure decision layer: it validates the caller's
 * `format` / `delivery` inputs and returns a normalised
 * {@link ShareDeliveryPlan} the IPC handler executes. Keeping it
 * free of the bridge / client makes the selection logic unit-
 * testable (the explicitly-requested "share-format selection"
 * tests live against {@link selectShareDelivery}).
 */

/** Export formats the share path understands. */
export const SHARE_FORMATS = [
  "markdown",
  "html",
  "pdf",
  "docx",
  "json",
] as const;
export type KchatShareFormat = (typeof SHARE_FORMATS)[number];

/** How the artifact is delivered to the channel. */
export const SHARE_DELIVERIES = ["attachment", "deeplink"] as const;
export type KchatShareDelivery = (typeof SHARE_DELIVERIES)[number];

/** Formats that produce binary (non-text) bytes. */
const BINARY_FORMATS: ReadonlySet<KchatShareFormat> = new Set(["pdf", "docx"]);

export interface ShareDeliveryPlan {
  delivery: KchatShareDelivery;
  format: KchatShareFormat;
  /**
   * `true` when the artifact must be exported to bytes and
   * uploaded (every `attachment` delivery). `false` for `deeplink`,
   * where no export happens — the format is retained only for the
   * audit row so the operator can see what the user intended.
   */
  requiresExport: boolean;
  /** `true` when the chosen format yields binary bytes (PDF/DOCX). */
  isBinary: boolean;
}

export interface SelectShareDeliveryInput {
  format?: unknown;
  delivery?: unknown;
}

export function isShareFormat(value: unknown): value is KchatShareFormat {
  return (
    typeof value === "string" &&
    (SHARE_FORMATS as readonly string[]).includes(value)
  );
}

export function isShareDelivery(value: unknown): value is KchatShareDelivery {
  return (
    typeof value === "string" &&
    (SHARE_DELIVERIES as readonly string[]).includes(value)
  );
}

/**
 * Validate and normalise a share request into a
 * {@link ShareDeliveryPlan}.
 *
 * Defaults preserve backward compatibility: an omitted `delivery`
 * is `attachment` and an omitted `format` is `markdown`, so an
 * existing caller that passes only `format: "markdown"` behaves
 * exactly as before. Invalid values throw — the IPC layer maps the
 * throw to a validation error rather than silently sharing the
 * wrong thing.
 */
export function selectShareDelivery(
  input: SelectShareDeliveryInput,
): ShareDeliveryPlan {
  const deliveryRaw =
    input.delivery === undefined || input.delivery === null
      ? "attachment"
      : input.delivery;
  if (!isShareDelivery(deliveryRaw)) {
    throw new Error(
      `invalid share delivery: ${String(input.delivery)} (expected one of ${SHARE_DELIVERIES.join(", ")})`,
    );
  }
  const delivery: KchatShareDelivery = deliveryRaw;

  const formatRaw =
    input.format === undefined || input.format === null
      ? "markdown"
      : input.format;
  if (!isShareFormat(formatRaw)) {
    throw new Error(
      `invalid share format: ${String(input.format)} (expected one of ${SHARE_FORMATS.join(", ")})`,
    );
  }
  const format: KchatShareFormat = formatRaw;

  return {
    delivery,
    format,
    requiresExport: delivery === "attachment",
    isBinary: BINARY_FORMATS.has(format),
  };
}
