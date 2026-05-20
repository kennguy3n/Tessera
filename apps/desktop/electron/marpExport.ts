/**
 * Marp export module — invokes Marp CLI programmatically to convert a Marp
 * markdown deck into PPTX (or PDF / HTML / images). The Electron main
 * process spawns this via IPC so the heavy puppeteer-core dependency stays
 * out of the renderer bundle.
 *
 * Real implementation notes:
 *
 *  - Marp CLI uses puppeteer-core to control a Chromium instance for PPTX
 *    and PDF backends. In a packaged Electron build we cannot rely on a
 *    user-installed system Chrome, nor on puppeteer-core auto-downloading
 *    one (it can't, the marp-cli npm bundle is shipped without the Chromium
 *    download manager, and the renderer sandbox doesn't allow it anyway).
 *    The `defaultRunner` path below therefore sets PUPPETEER_EXECUTABLE_PATH
 *    to Electron's own bundled Chromium (`process.execPath`) before loading
 *    `@marp-team/marp-cli`, so puppeteer-core launches the Electron binary
 *    in headless mode instead of looking for a separate Chrome install.
 *    Callers (or tests) that need a different Chromium can pre-set the env
 *    var externally — we only fill it in when it is not already set.
 *
 *  - The temp file dance (write md → run cli → read output) keeps the API
 *    surface symmetric across formats and matches the upstream CLI contract.
 *
 *  - This module is deliberately small and testable: `buildMarpArgs` is a
 *    pure function and is exercised by the unit tests. `runMarpExport` is
 *    integration-style; the test suite ships a fake CLI runner via the
 *    `runner` injection point, which bypasses `defaultRunner` entirely
 *    (and therefore the PUPPETEER_EXECUTABLE_PATH env-var injection).
 */
import * as crypto from "crypto";
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
  // Point puppeteer-core at Electron's bundled Chromium before loading
  // @marp-team/marp-cli. puppeteer-core resolves its executable at
  // import-time via PUPPETEER_EXECUTABLE_PATH, so this must run BEFORE the
  // dynamic import below. We only fill the var in when it is not already
  // set so callers can override (e.g. tests, system-Chrome installs, or a
  // custom Chromium revision pinned for repro).
  if (!process.env.PUPPETEER_EXECUTABLE_PATH) {
    // `process.execPath` is the Electron binary in a packaged build and the
    // host Node binary in `npm run dev`. The latter is harmless: marp-cli
    // will fail to launch puppeteer against a Node binary, but development
    // workflows use the in-app renderer path (no marp-cli) anyway. The
    // packaged-build path is the one that matters for end users.
    process.env.PUPPETEER_EXECUTABLE_PATH = process.execPath;
  }
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
      // Marp CLI treats HTML as the default output format and infers it
      // from the `-o` extension; there is no explicit "--html-output" flag.
      // (`--html` is a separate switch that enables inline HTML in the
      // source markdown — see `opts.allowHtml` below.)
      break;
    case "png":
      args.push("--images", "png");
      break;
    case "jpeg":
      args.push("--images", "jpeg");
      break;
  }
  if (opts.theme) args.push("--theme", opts.theme);
  // `--pdf-notes` is a PDF-only Marp CLI flag — it renders speaker-notes as
  // PDF annotations. PPTX exports already place HTML-comment notes into the
  // pptx notes pane natively (no CLI flag exists for that), so passing
  // `--pdf-notes` to a `--pptx` invocation is a no-op at best and a warning
  // at worst. Keep the flag strictly scoped to PDF.
  if (opts.includeNotes && opts.format === "pdf") {
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
 * and returns the output path and byte count. The temp input file is always
 * removed by this function (success or failure); the output file is left
 * intact for the caller.
 */
export async function runMarpExport(
  opts: MarpExportOptions,
): Promise<MarpExportResult> {
  if (!opts.markdown || !opts.markdown.trim()) {
    throw new Error("runMarpExport: empty markdown");
  }
  const tmpDir = opts.tmpDir ?? os.tmpdir();
  // Use crypto.randomBytes for the temp-file unique suffix instead of
  // Math.random(): two concurrent exports issued in the same millisecond
  // can still occur (debounced auto-export + manual click) and Math.random
  // is not collision-safe for filesystem paths. 8 random bytes ≈ 2^64
  // namespace, effectively eliminates collisions.
  const tmpInput = path.join(
    tmpDir,
    `tessera-marp-${Date.now()}-${crypto.randomBytes(8).toString("hex")}.md`,
  );
  const outputPath =
    opts.outputPath ??
    path.join(
      tmpDir,
      `tessera-marp-${Date.now()}-${crypto.randomBytes(8).toString("hex")}.${defaultExtensionFor(opts.format)}`,
    );

  await fs.promises.mkdir(tmpDir, { recursive: true });
  // Defensive: ensure the parent of `outputPath` exists too. In production the
  // sole caller (`apps/desktop/electron/ipc.ts`) already does this before
  // invoking `runMarpExport`, but this keeps the function self-contained for
  // future callers (CLI tools, batch export scripts, tests) — without it,
  // Marp CLI fails with ENOENT when the parent directory does not yet exist.
  // `recursive: true` is a no-op when the directory already exists, so this
  // adds no observable cost on the production hot-path either.
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
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
