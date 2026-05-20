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
});
