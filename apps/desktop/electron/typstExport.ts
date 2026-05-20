//! Typst-powered PDF/SVG export bridge — invoked from the renderer over IPC.
//!
//! This module spawns an out-of-process Rust helper via `tessera_export`'s
//! Typst feature. Because the Typst engine is gated behind a Cargo feature
//! (the dependency is heavy and not needed for the default desktop build),
//! the helper is compiled separately under `crates/tessera_export` with
//! `--features typst`. The Electron main process invokes it through the
//! existing native bridge if available; otherwise the renderer can still
//! preview Typst markup via WebAssembly in a future iteration.

import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type TypstExportFormat = "pdf" | "svg";

export interface TypstExportOptions {
  markup: string;
  format: TypstExportFormat;
  outputPath?: string;
  tmpDir?: string;
}

export interface TypstExportResult {
  outputPath: string;
  bytes: number;
}

export type TypstRunner = (
  markup: string,
  format: TypstExportFormat,
) => Promise<Buffer>;

let runner: TypstRunner | null = null;

/**
 * Replace the default Typst runner. Used by unit tests to avoid spawning a
 * real Typst process; production code should leave this alone so the
 * default runner (which calls the native bridge) is used.
 */
export function __setTypstRunner(custom: TypstRunner | null) {
  runner = custom;
}

/**
 * Default Typst runner — calls the native bridge built from
 * `crates/tessera_export` with the `typst` feature enabled. The bridge
 * exposes `bridgeExportTypst({markup, format}) -> Buffer`.
 */
async function defaultRunner(
  markup: string,
  format: TypstExportFormat,
): Promise<Buffer> {
  const { getBridge } = await import("./appState");
  const bridge = getBridge();
  // The Typst bridge entry-point is added in a separate native build step
  // (gated behind the `typst` Cargo feature). At type-check time the
  // NativeBridge interface doesn't include it, so we test for it
  // dynamically via `unknown` -> structural check.
  const bridgeUnknown = bridge as unknown as {
    bridgeExportTypst?: (req: {
      markup: string;
      format: TypstExportFormat;
    }) => Promise<Buffer | Uint8Array | string>;
  };
  if (bridgeUnknown && typeof bridgeUnknown.bridgeExportTypst === "function") {
    const out = await bridgeUnknown.bridgeExportTypst({ markup, format });
    if (Buffer.isBuffer(out)) return out;
    if (typeof out === "string") return Buffer.from(out, "utf8");
    return Buffer.from(out);
  }
  // No native bridge available — fall back to the standalone CLI shipped
  // alongside the desktop binary. The CLI is built from
  // crates/tessera_export with `--bin tessera-typst-export`.
  return await new Promise((resolve, reject) => {
    const exe = process.env.TESSERA_TYPST_CLI ?? "tessera-typst-export";
    const proc = spawn(exe, ["--format", format], { stdio: "pipe" });
    const chunks: Buffer[] = [];
    proc.stdout.on("data", (d: Buffer) => chunks.push(d));
    let stderr = "";
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    proc.on("error", (err) => reject(err));
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `Typst CLI exited with code ${code}${stderr ? ": " + stderr : ""}`,
          ),
        );
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    proc.stdin.write(markup, "utf8");
    proc.stdin.end();
  });
}

/**
 * Run a Typst export end-to-end:
 *   1. Hand the markup + format to the configured runner.
 *   2. Write the resulting bytes to `outputPath` (or a temp file if the
 *      caller didn't supply one).
 *   3. Return the final path + byte count.
 */
export async function runTypstExport(
  opts: TypstExportOptions,
): Promise<TypstExportResult> {
  if (!opts.markup || opts.markup.trim().length === 0) {
    throw new Error("Typst markup is empty");
  }
  const fn = runner ?? defaultRunner;
  const bytes = await fn(opts.markup, opts.format);
  const tmpDir = opts.tmpDir ?? os.tmpdir();
  // Use crypto.randomBytes for the temp-file unique suffix instead of
  // Math.random(): two concurrent exports issued in the same millisecond
  // can still occur (debounced auto-export + manual click) and Math.random
  // is not collision-safe for filesystem paths. 8 random bytes ≈ 2^64
  // namespace, effectively eliminates collisions. Mirrors the equivalent
  // fix in `marpExport.ts` so both export pipelines share the same
  // collision-safety guarantee.
  const outputPath =
    opts.outputPath ??
    path.join(
      tmpDir,
      `tessera-typst-${Date.now()}-${crypto.randomBytes(8).toString("hex")}.${opts.format}`,
    );
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, bytes);
  const stat = await fs.stat(outputPath);
  return { outputPath, bytes: stat.size };
}
