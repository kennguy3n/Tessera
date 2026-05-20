/**
 * Marp export module — invokes Marp CLI programmatically to convert a Marp
 * markdown deck into PPTX (or PDF / HTML / images). The Electron main
 * process spawns this via IPC so the heavy puppeteer-core dependency stays
 * out of the renderer bundle.
 *
 * Real implementation notes:
 *
 *  - Marp CLI uses puppeteer-core to control a Chromium instance for PPTX
 *    and PDF backends. In packaged builds Electron's own Chromium is reused
 *    via the PUPPETEER_EXECUTABLE_PATH env var pointing to `process.execPath`
 *    or `app.getPath('exe')`. Callers are expected to set that before
 *    invoking `runMarpExport`; this module does NOT mutate process.env.
 *
 *  - The temp file dance (write md → run cli → read output) keeps the API
 *    surface symmetric across formats and matches the upstream CLI contract.
 *
 *  - This module is deliberately small and testable: `buildMarpArgs` is a
 *    pure function and is exercised by the unit tests. `runMarpExport` is
 *    integration-style; the test suite ships a fake CLI runner via the
 *    `runner` injection point.
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export type MarpExportFormat = "pdf" | "pptx" | "html" | "png" | "jpeg";

export interface MarpExportOptions {
  /** Marp-flavoured markdown content. */
  markdown: string;
  /** Output file path. Extension is derived from `format` if omitted. */
  outputPath?: string;
  format: MarpExportFormat;
  /** Theme name passed to Marp via `--theme`. */
  theme?: string;
  /** Enable speaker-note export (Marp `--notes`). */
  includeNotes?: boolean;
  /** Allow inline HTML in the input. */
  allowHtml?: boolean;
  /** Override the temp directory (default: `os.tmpdir()`). */
  tmpDir?: string;
}

export interface MarpExportResult {
  outputPath: string;
  bytes: number;
}

/** Lazy import of marp-cli so unit tests can avoid pulling in puppeteer. */
type MarpRunner = (argv: string[]) => Promise<number>;
let cachedRunner: MarpRunner | null = null;

async function defaultRunner(argv: string[]): Promise<number> {
  // `@marp-team/marp-cli` exports a default `marpCli(argv)` function.
  const mod = (await import("@marp-team/marp-cli")) as unknown as {
    default?: (argv: string[]) => Promise<number>;
    marpCli?: (argv: string[]) => Promise<number>;
  };
  const fn = mod.default ?? mod.marpCli;
  if (!fn) throw new Error("@marp-team/marp-cli has no callable default export");
  return await fn(argv);
}

/** Reset the cached runner — for tests. */
export function __setMarpRunner(runner: MarpRunner | null) {
  cachedRunner = runner;
}

/**
 * Build the argv array passed to `marpCli`. Pure function — exercised in
 * unit tests.
 */
export function buildMarpArgs(
  inputPath: string,
  outputPath: string,
  opts: Pick<MarpExportOptions, "format" | "theme" | "includeNotes" | "allowHtml">,
): string[] {
  const args = [inputPath, "-o", outputPath];
  switch (opts.format) {
    case "pdf":
      args.push("--pdf");
      break;
    case "pptx":
      args.push("--pptx");
      break;
    case "html":
      args.push("--html-output");
      break;
    case "png":
      args.push("--images", "png");
      break;
    case "jpeg":
      args.push("--images", "jpeg");
      break;
  }
  if (opts.theme) args.push("--theme", opts.theme);
  if (opts.includeNotes && (opts.format === "pdf" || opts.format === "pptx")) {
    args.push("--pdf-notes");
  }
  if (opts.allowHtml) args.push("--html");
  return args;
}

function defaultExtensionFor(format: MarpExportFormat): string {
  switch (format) {
    case "pdf":
      return "pdf";
    case "pptx":
      return "pptx";
    case "html":
      return "html";
    case "png":
      return "png";
    case "jpeg":
      return "jpg";
  }
}

/**
 * Run a Marp export. Writes the markdown to a temp file, invokes Marp CLI,
 * and returns the output path and byte count. The Electron main process owns
 * the temp-file lifecycle; this function does NOT delete the input file on
 * success (caller decides).
 */
export async function runMarpExport(
  opts: MarpExportOptions,
): Promise<MarpExportResult> {
  if (!opts.markdown || !opts.markdown.trim()) {
    throw new Error("runMarpExport: empty markdown");
  }
  const tmpDir = opts.tmpDir ?? os.tmpdir();
  const tmpInput = path.join(
    tmpDir,
    `tessera-marp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`,
  );
  const outputPath =
    opts.outputPath ??
    path.join(
      tmpDir,
      `tessera-marp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${defaultExtensionFor(opts.format)}`,
    );

  await fs.promises.mkdir(tmpDir, { recursive: true });
  await fs.promises.writeFile(tmpInput, opts.markdown, "utf-8");
  try {
    const argv = buildMarpArgs(tmpInput, outputPath, opts);
    const runner = cachedRunner ?? defaultRunner;
    const exitCode = await runner(argv);
    if (exitCode !== 0) {
      throw new Error(`Marp CLI exited with code ${exitCode}`);
    }
    const stat = await fs.promises.stat(outputPath);
    return { outputPath, bytes: stat.size };
  } finally {
    await fs.promises.unlink(tmpInput).catch(() => {
      /* best effort */
    });
  }
}
