import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Logger imports `electron`; we never call `app.getPath` because we
// pass an explicit `dir`, but the import still has to resolve.
vi.mock("electron", () => ({
  app: { getPath: vi.fn().mockReturnValue("/tmp/devin-tessera-logger-test") },
}));

import { createLogger } from "../logger";

/**
 * Locks down the JSONL logger contract.
 *
 * review flagged a possible "tessera.log skipped on initial
 * rename" bug in the rotation loop. We assert the actual behaviour
 * here: when `tessera.log` exceeds the size cap, it must rotate to
 * `tessera.1.log`, and existing numbered files must shift outward
 * up to `maxFiles - 1`. Any older file beyond that is dropped.
 */
describe("createLogger", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tessera-logger-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes JSON-lines records with level, message and fields", () => {
    const logger = createLogger({ dir, minLevel: "debug" });
    logger.info("hello", { kind: "test" });
    logger.warn("careful", { code: 42 });
    const contents = fs.readFileSync(logger.filePath(), "utf8");
    const lines = contents.trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    expect(first).toMatchObject({
      level: "info",
      message: "hello",
      kind: "test",
    });
    const second = JSON.parse(lines[1]);
    expect(second).toMatchObject({
      level: "warn",
      message: "careful",
      code: 42,
    });
  });

  it("respects minLevel and drops lower-priority records", () => {
    const logger = createLogger({ dir, minLevel: "warn" });
    logger.debug("noisy");
    logger.info("also noisy");
    logger.warn("kept");
    const lines = fs
      .readFileSync(logger.filePath(), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).message).toBe("kept");
  });

  it("rotates tessera.log -> tessera.1.log once it exceeds maxFileBytes", () => {
    // 200-byte cap, so a few INFO records exceeds it.
    const logger = createLogger({
      dir,
      minLevel: "debug",
      maxFileBytes: 200,
      maxFiles: 3,
    });
    for (let i = 0; i < 8; i += 1) logger.info(`payload-${i}`);
    const files = fs.readdirSync(dir).sort();
    // After rotation, the active file is fresh again and there must
    // be a tessera.1.log containing the prior content. This is the
    // exact behaviour the review flag worried was missing.
    expect(files).toContain("tessera.log");
    expect(files).toContain("tessera.1.log");
    const rotated = fs.readFileSync(path.join(dir, "tessera.1.log"), "utf8");
    expect(rotated.length).toBeGreaterThan(0);
  });

  it("caps the number of rotated files at maxFiles", () => {
    const logger = createLogger({
      dir,
      minLevel: "debug",
      maxFileBytes: 50,
      maxFiles: 3,
    });
    // Force many rotations.
    for (let i = 0; i < 50; i += 1) logger.info(`payload-${i}`);
    const numbered = fs
      .readdirSync(dir)
      .filter((f) => /^tessera\.\d+\.log$/.test(f));
    // maxFiles=3 keeps active + tessera.1.log + tessera.2.log only.
    expect(numbered.length).toBeLessThanOrEqual(2);
  });

  it("exposes filePath() and dirPath() pointing at the active log", () => {
    const logger = createLogger({ dir });
    expect(logger.dirPath()).toBe(dir);
    expect(logger.filePath()).toBe(path.join(dir, "tessera.log"));
  });
});
