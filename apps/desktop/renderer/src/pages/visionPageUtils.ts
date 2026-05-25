/**
 * Sibling-of-`VisionPage` utility module — holds the constants and
 * pure helpers that `VisionPage.tsx` needs to expose to tests and
 * future call sites without tripping
 * `react-refresh/only-export-components` (which fires when a file
 * exports both a React component AND non-component values, since
 * React Fast Refresh can only hot-reload modules that exclusively
 * export components).
 *
 * Keep this module FREE of React imports and JSX — it should be
 * cheap to import from a non-React context (e.g. a future
 * `tessera.vision.describe` integration test that runs in the
 * main-process suite without a DOM).
 */

export type VisionMode = "describe" | "ocr" | "chart";

export interface VisionModeOption {
  id: VisionMode;
  label: string;
  description: string;
}

/**
 * Pinned canonical order of the mode toggle. Exported so the page
 * tests can assert the order without re-typing the labels (the
 * label strings appear in both the toggle and the saved artifact
 * title, so any rename needs to update both).
 */
export const VISION_MODE_OPTIONS: readonly VisionModeOption[] = [
  {
    id: "describe",
    label: "Describe",
    description:
      "Natural-language description of the image — what's in it, the layout, the mood.",
  },
  {
    id: "ocr",
    label: "OCR",
    description:
      "Literal transcription of text visible in the image — including handwriting and signs.",
  },
  {
    id: "chart",
    label: "Chart",
    description:
      "Structured extraction of axes, series, and values from a chart or diagram.",
  },
] as const;

export const DEFAULT_VISION_MAX_TOKENS = 512;
export const MIN_VISION_MAX_TOKENS = 64;
export const MAX_VISION_MAX_TOKENS = 2048;

export interface VisionResult {
  content: string;
  stop: boolean;
  tokensPredicted: number;
  tokensEvaluated: number;
}

/**
 * Compose the saved-document title and Markdown body for a vision
 * result. Pure — no React, no DOM, no IPC. Used by both
 * `VisionPage`'s Save-as-Document handler and the page tests.
 *
 * The Markdown body intentionally encodes the source-image
 * basename, mode, and token counts at the top so a user opening the
 * artifact months later sees the full provenance trail without
 * having to remember which image / mode they used. The path itself
 * is NOT persisted because the user is free to move / delete the
 * image and we don't want to surface a broken-link artifact.
 */
export function buildVisionDocument(args: {
  imagePath: string;
  mode: VisionMode;
  maxTokens: number;
  result: VisionResult;
}): { title: string; markdown: string } {
  const basename = args.imagePath.split(/[\\/]/).pop() ?? "image";
  const modeLabel =
    VISION_MODE_OPTIONS.find((o) => o.id === args.mode)?.label ?? args.mode;
  const title = `Vision: ${modeLabel} — ${basename}`;
  const truncated = !args.result.stop;
  const lines: string[] = [
    `# ${title}`,
    "",
    `**Source image:** \`${basename}\``,
    `**Mode:** ${modeLabel}`,
    `**Tokens predicted:** ${args.result.tokensPredicted} of ${args.maxTokens}`,
    `**Tokens evaluated (prompt + image):** ${args.result.tokensEvaluated}`,
    "",
  ];
  if (truncated) {
    lines.push(
      "> ⚠️ Output was truncated by the max-tokens cap. Increase the slider and re-run if you need more.",
      "",
    );
  }
  lines.push("---", "", args.result.content.trim() || "_(empty output)_");
  return { title, markdown: lines.join("\n") };
}
