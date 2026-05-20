import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  buildMarpArgs,
  runMarpExport,
  __setMarpRunner,
} from "../marpExport";

describe("marpExport", () => {
  describe("buildMarpArgs", () => {
    it("constructs base argv for PDF export", () => {
      const argv = buildMarpArgs("in.md", "out.pdf", { format: "pdf" });
      expect(argv).toEqual(["in.md", "-o", "out.pdf", "--pdf"]);
    });

    it("constructs base argv for PPTX export", () => {
      const argv = buildMarpArgs("in.md", "out.pptx", { format: "pptx" });
      expect(argv).toEqual(["in.md", "-o", "out.pptx", "--pptx"]);
    });

    it("appends theme when supplied", () => {
      const argv = buildMarpArgs("in.md", "out.pdf", {
        format: "pdf",
        theme: "gaia",
      });
      expect(argv).toContain("--theme");
      expect(argv).toContain("gaia");
    });

    it("appends --pdf-notes when includeNotes && pdf/pptx", () => {
      expect(
        buildMarpArgs("in.md", "out.pdf", {
          format: "pdf",
          includeNotes: true,
        }),
      ).toContain("--pdf-notes");
      expect(
        buildMarpArgs("in.md", "out.pptx", {
          format: "pptx",
          includeNotes: true,
        }),
      ).toContain("--pdf-notes");
    });

    it("does NOT append --pdf-notes for html exports", () => {
      const argv = buildMarpArgs("in.md", "out.html", {
        format: "html",
        includeNotes: true,
      });
      expect(argv).not.toContain("--pdf-notes");
    });

    it("emits no explicit format flag for html (CLI infers from -o extension)", () => {
      // Marp CLI has no `--html-output` flag; HTML is the default and is
      // inferred from the output file extension. The `--html` flag exists
      // for a different purpose (allowing inline HTML in the source).
      const argv = buildMarpArgs("in.md", "out.html", { format: "html" });
      expect(argv).toEqual(["in.md", "-o", "out.html"]);
      expect(argv).not.toContain("--html-output");
      expect(argv).not.toContain("--html");
    });

    it("appends --html when allowHtml=true", () => {
      const argv = buildMarpArgs("in.md", "out.pdf", {
        format: "pdf",
        allowHtml: true,
      });
      expect(argv).toContain("--html");
    });

    it("maps image format to --images", () => {
      expect(buildMarpArgs("in.md", "out.png", { format: "png" })).toEqual([
        "in.md",
        "-o",
        "out.png",
        "--images",
        "png",
      ]);
      expect(buildMarpArgs("in.md", "out.jpg", { format: "jpeg" })).toEqual([
        "in.md",
        "-o",
        "out.jpg",
        "--images",
        "jpeg",
      ]);
    });
  });

  describe("runMarpExport", () => {
    let tmpDir: string;
    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tessera-marp-test-"));
    });
    afterEach(() => {
      __setMarpRunner(null);
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* noop */
      }
    });

    it("writes the markdown to a temp file and invokes the runner", async () => {
      let observedArgv: string[] | null = null;
      __setMarpRunner(async (argv) => {
        observedArgv = argv;
        // Simulate the CLI by creating an empty output file.
        const out = argv[argv.indexOf("-o") + 1];
        fs.writeFileSync(out, "fake pptx bytes");
        return 0;
      });
      const result = await runMarpExport({
        markdown: "# Hello",
        format: "pptx",
        tmpDir,
      });
      expect(observedArgv).not.toBeNull();
      const argv = observedArgv as unknown as string[];
      expect(argv[1]).toBe("-o");
      expect(argv).toContain("--pptx");
      expect(result.bytes).toBeGreaterThan(0);
      expect(fs.existsSync(result.outputPath)).toBe(true);
    });

    it("rejects empty markdown", async () => {
      await expect(
        runMarpExport({ markdown: "", format: "pdf", tmpDir }),
      ).rejects.toThrow(/empty markdown/);
    });

    it("propagates non-zero exit code as an error", async () => {
      __setMarpRunner(async () => 7);
      await expect(
        runMarpExport({ markdown: "# x", format: "pdf", tmpDir }),
      ).rejects.toThrow(/code 7/);
    });

    it("cleans up the temp input file after success", async () => {
      const before = new Set(fs.readdirSync(tmpDir));
      __setMarpRunner(async (argv) => {
        const out = argv[argv.indexOf("-o") + 1];
        fs.writeFileSync(out, "x");
        return 0;
      });
      await runMarpExport({ markdown: "# x", format: "pptx", tmpDir });
      const after = fs.readdirSync(tmpDir);
      const newFiles = after.filter((f) => !before.has(f));
      // Only the output file should remain.
      expect(newFiles.length).toBe(1);
      expect(newFiles[0]).toMatch(/\.pptx$/);
    });
  });
});
