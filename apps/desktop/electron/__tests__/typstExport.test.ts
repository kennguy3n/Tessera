import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  runTypstExport,
  __setTypstRunner,
  type TypstExportFormat,
} from "../typstExport";

describe("typstExport", () => {
  const tmpRoot = path.join(os.tmpdir(), "tessera-typst-test");

  beforeEach(() => {
    fs.mkdirSync(tmpRoot, { recursive: true });
  });

  afterEach(() => {
    __setTypstRunner(null);
    // Best-effort cleanup; ignore errors so a failing test doesn't tip
    // another one into a false failure.
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* swallow */
    }
  });

  it("rejects empty markup", async () => {
    await expect(
      runTypstExport({ markup: "   ", format: "pdf" }),
    ).rejects.toThrow(/empty/i);
  });

  it("writes the runner's bytes to the supplied output path", async () => {
    const fake = Buffer.from("%PDF-1.4 fake-bytes\n", "utf8");
    __setTypstRunner(async (_markup, format) => {
      expect(format).toBe("pdf");
      return fake;
    });
    const out = path.join(tmpRoot, "out.pdf");
    const result = await runTypstExport({
      markup: "= Hello",
      format: "pdf",
      outputPath: out,
    });
    expect(result.outputPath).toBe(out);
    expect(result.bytes).toBe(fake.length);
    const read = fs.readFileSync(out);
    expect(Buffer.compare(read, fake)).toBe(0);
  });

  it("creates a temp file when outputPath is omitted", async () => {
    const fake = Buffer.from("<svg><g/></svg>", "utf8");
    __setTypstRunner(async () => fake);
    const result = await runTypstExport({
      markup: "= Hello",
      format: "svg",
      tmpDir: tmpRoot,
    });
    expect(result.outputPath.startsWith(tmpRoot)).toBe(true);
    expect(result.outputPath.endsWith(".svg")).toBe(true);
    expect(result.bytes).toBe(fake.length);
  });

  it("passes the requested format to the runner", async () => {
    const observed: TypstExportFormat[] = [];
    __setTypstRunner(async (_m, format) => {
      observed.push(format);
      return Buffer.from("OK");
    });
    await runTypstExport({
      markup: "x",
      format: "pdf",
      outputPath: path.join(tmpRoot, "a.pdf"),
    });
    await runTypstExport({
      markup: "x",
      format: "svg",
      outputPath: path.join(tmpRoot, "b.svg"),
    });
    expect(observed).toEqual(["pdf", "svg"]);
  });

  it("propagates runner errors", async () => {
    __setTypstRunner(async () => {
      throw new Error("typst-compile-failed");
    });
    await expect(
      runTypstExport({
        markup: "= Bad",
        format: "pdf",
        outputPath: path.join(tmpRoot, "bad.pdf"),
      }),
    ).rejects.toThrow(/typst-compile-failed/);
  });

  it("uses crypto.randomBytes for temp-file uniqueness (regression for BUG_681f8bfb_0001)", async () => {
    // Same class of bug as marpExport's earlier fix: two concurrent
    // exports issued in the same millisecond would collide on the
    // Math.random()-derived suffix (only ~2.2e9 namespace). 8 random
    // bytes (16 hex chars) gives ~1.8e19 namespace, effectively
    // eliminating collisions. We fire 50 exports back-to-back so
    // Date.now() is much more likely to repeat than under any normal
    // workload, then assert every observed temp basename is unique and
    // matches the new shape.
    __setTypstRunner(async () => Buffer.from("OK"));
    const runs = Array.from({ length: 50 }, () =>
      runTypstExport({ markup: "= x", format: "pdf", tmpDir: tmpRoot }),
    );
    const results = await Promise.all(runs);
    const basenames = new Set(results.map((r) => path.basename(r.outputPath)));
    expect(basenames.size).toBe(50);
    for (const name of basenames) {
      expect(name).toMatch(/^tessera-typst-\d+-[0-9a-f]{16}\.pdf$/);
    }
  });
});
