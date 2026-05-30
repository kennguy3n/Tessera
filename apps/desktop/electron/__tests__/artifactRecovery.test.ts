/**
 * Phase 15 Task 8 — `artifactRecovery.ts` regression suite.
 *
 * The recovery module is the safety net for the auto-save IPC chain
 * — a process crash between the renderer firing `artifacts:update`
 * and the bridge committing to the DB would lose the most recent
 * keystrokes without this. The tests exercise the three documented
 * failure modes the production code is supposed to survive:
 *
 *   1. Successful write + read round-trip (the common case after
 *      every auto-save).
 *   2. Crash simulated mid-bridge-call: write the sidecar, do NOT
 *      clear it, reopen and observe the sidecar is still there with
 *      identical content. This is the "main crashed mid-N-API-call"
 *      recovery contract.
 *   3. Stale sidecar (timestamp older than DB row) detection: the
 *      `loadRecovery` helper returns the envelope, and the consumer
 *      (the `artifacts:checkRecovery` handler) is responsible for
 *      the timestamp comparison — so the helper test pins that
 *      "older sidecar is still returned" and the handler-side test
 *      (in `artifactRecoveryIpc.test.ts`) pins the comparison.
 *
 * Plus the structural-integrity tests: missing sidecars resolve to
 * null, malformed JSON resolves to null, sidecars for a different
 * artifact id (collision after id-sanitisation) resolve to null,
 * V≠1 envelopes resolve to null. These prevent a regression in
 * `loadRecovery` from silently restoring corrupt content.
 *
 * We deliberately do NOT mock `fs` — these tests run against a real
 * `tempdir()` because the production code's atomic-write contract
 * (`open → writeFile → fsync → rename`) is exactly what we want to
 * verify. A `vol`-style mock that elides the fsync would make the
 * tests pass while letting a production regression slip in.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  writeRecovery,
  loadRecovery,
  clearRecovery,
  setRecoveryDirOverrideForTests,
} from "../artifactRecovery";

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tessera-recovery-"));
  setRecoveryDirOverrideForTests(tempDir);
});

afterEach(async () => {
  setRecoveryDirOverrideForTests(null);
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("artifactRecovery: write/read round-trip", () => {
  it("persists the envelope byte-for-byte across a write/read cycle", async () => {
    const id = "art_abc123";
    const content = "# Heading\n\nThe body of the document.";
    await writeRecovery(id, content);
    const env = await loadRecovery(id);
    expect(env).not.toBeNull();
    expect(env!.artifactId).toBe(id);
    expect(env!.content).toBe(content);
    expect(env!.version).toBe(1);
    expect(typeof env!.timestamp).toBe("number");
    expect(env!.timestamp).toBeGreaterThan(0);
  });

  it("overwrites a prior sidecar atomically", async () => {
    const id = "art_overwrite";
    await writeRecovery(id, "first");
    await writeRecovery(id, "second");
    await writeRecovery(id, "third");
    const env = await loadRecovery(id);
    expect(env!.content).toBe("third");
  });

  it("creates the recovery directory if it doesn't exist", async () => {
    // Aim the override at a not-yet-created subdir so writeRecovery
    // has to mkdir-p before it can write. This pins the docstring's
    // "best-effort mkdir-p" claim.
    const nested = path.join(tempDir, "nested", "deeper");
    setRecoveryDirOverrideForTests(nested);
    await writeRecovery("art_mkdir", "x");
    const env = await loadRecovery("art_mkdir");
    expect(env!.content).toBe("x");
  });

  it("does not leak a `.tmp-*` file after a successful write", async () => {
    // The atomic-write contract leaves the temp file in place only
    // if the rename fails. On a healthy fs the temp file MUST be
    // gone after the rename.
    await writeRecovery("art_no_tmp", "y");
    const entries = await fs.readdir(tempDir);
    const tmpEntries = entries.filter((e) => e.includes(".tmp-"));
    expect(tmpEntries).toEqual([]);
  });
});

describe("artifactRecovery: crash recovery contract", () => {
  it("preserves the sidecar when the bridge save would have crashed", async () => {
    // Simulate the production sequence: write the sidecar (pre-
    // bridge-call), then the process crashes BEFORE clearRecovery
    // would have been called. The next launch must observe the
    // sidecar intact.
    const id = "art_crash";
    const content = "the user's unsaved paragraph that must survive";
    await writeRecovery(id, content);
    // ... main process crashes here — no clearRecovery() call ...

    // Simulate next launch (re-init the override to the same path,
    // because the cold start would re-derive userData from
    // `app.getPath("userData")`).
    setRecoveryDirOverrideForTests(tempDir);
    const env = await loadRecovery(id);
    expect(env).not.toBeNull();
    expect(env!.content).toBe(content);
  });

  it("retains the sidecar across multiple unrelated reads", async () => {
    // loadRecovery is non-destructive — a check probe must NOT
    // remove the sidecar (only an explicit clearRecovery /
    // discardRecovery may). Pin this so a future refactor that
    // adds "consume after read" semantics is caught.
    const id = "art_persist_after_read";
    await writeRecovery(id, "data");
    await loadRecovery(id);
    await loadRecovery(id);
    await loadRecovery(id);
    const env = await loadRecovery(id);
    expect(env).not.toBeNull();
    expect(env!.content).toBe("data");
  });
});

describe("artifactRecovery: malformed / missing sidecars", () => {
  it("returns null for an artifact with no sidecar", async () => {
    const env = await loadRecovery("art_does_not_exist");
    expect(env).toBeNull();
  });

  it("returns null for malformed JSON instead of throwing", async () => {
    // A truncated JSON write (e.g. fsync interrupted by a power
    // loss before the trailing brace landed) must not throw on
    // open — the worst case is "no recovery", strictly better
    // than crashing the open path.
    const id = "art_bad_json";
    const sidecarPath = path.join(tempDir, `${id}.json`);
    await fs.writeFile(sidecarPath, "{not valid json");
    const env = await loadRecovery(id);
    expect(env).toBeNull();
  });

  it("returns null for a sidecar with a future version", async () => {
    // Forward-compatibility: a Tessera that wrote a V2 envelope
    // must not have an older Tessera misinterpret it as V1.
    const id = "art_future_version";
    const sidecarPath = path.join(tempDir, `${id}.json`);
    await fs.writeFile(
      sidecarPath,
      JSON.stringify({
        version: 99,
        artifactId: id,
        content: "future data",
        timestamp: Date.now(),
      }),
    );
    const env = await loadRecovery(id);
    expect(env).toBeNull();
  });

  it("returns null when the sidecar id mismatches the requested id", async () => {
    // Defence against id-sanitisation collisions: even if two
    // distinct upstream ids both stripped to the same on-disk
    // filename, the envelope's recorded `artifactId` lets us
    // detect the mismatch and refuse to restore foreign content.
    const id = "art_id_a";
    const sidecarPath = path.join(tempDir, `${id}.json`);
    await fs.writeFile(
      sidecarPath,
      JSON.stringify({
        version: 1,
        artifactId: "art_id_b",
        content: "wrong artifact's data",
        timestamp: Date.now(),
      }),
    );
    const env = await loadRecovery(id);
    expect(env).toBeNull();
  });

  it("returns null for a sidecar missing required fields", async () => {
    const id = "art_missing_fields";
    const sidecarPath = path.join(tempDir, `${id}.json`);
    await fs.writeFile(
      sidecarPath,
      JSON.stringify({ version: 1, artifactId: id }),
    );
    const env = await loadRecovery(id);
    expect(env).toBeNull();
  });
});

describe("artifactRecovery: clear", () => {
  it("removes a present sidecar", async () => {
    const id = "art_clear";
    await writeRecovery(id, "data");
    expect(await loadRecovery(id)).not.toBeNull();
    await clearRecovery(id);
    expect(await loadRecovery(id)).toBeNull();
  });

  it("is a no-op for a missing sidecar (idempotent discard)", async () => {
    // The `artifacts:discardRecovery` handler relies on this — a
    // double-click on "Discard" must not fail the second call.
    await expect(clearRecovery("art_never_existed")).resolves.toBeUndefined();
  });
});

describe("artifactRecovery: path-traversal defence", () => {
  it("sanitises path separators in the artifact id", async () => {
    // Even though `assertId` upstream restricts the character
    // class, the recovery layer defensively strips path
    // separators so a regression in the validator can't turn
    // this into an arbitrary-write sink.
    const malicious = "../../etc/passwd";
    const sentinel = "tessera-recovery-test-content-do-not-restore";
    await writeRecovery(malicious, sentinel);
    // Whatever filename we landed on, it MUST be inside tempDir
    // — exactly one file, and the sentinel content must be
    // inside it. `fs.access` on `/etc/passwd` would succeed on
    // any real system, so the assertion is "we wrote into
    // tempDir, and our content didn't escape": check that
    // tempDir holds exactly one new file and its content is
    // exactly our payload.
    const entries = await fs.readdir(tempDir);
    expect(entries.length).toBe(1);
    const written = await fs.readFile(path.join(tempDir, entries[0]), "utf-8");
    expect(written).toContain(sentinel);
    // And the sentinel string must NOT appear in /etc/passwd —
    // if a regression silently lets the write escape, it would
    // have appended JSON to /etc/passwd (which would be denied
    // by the kernel anyway, but the test is the assertion
    // either way).
    const etcContent = await fs.readFile("/etc/passwd", "utf-8").catch(() => "");
    expect(etcContent).not.toContain(sentinel);
  });

  it("sanitises leading dots in the artifact id", async () => {
    // ".." / "..." -> stripped to "_..." so we don't accidentally
    // walk up the tree even after the separator strip.
    await writeRecovery("...sneak", "x");
    const entries = await fs.readdir(tempDir);
    expect(entries.every((e) => !e.startsWith(".."))).toBe(true);
  });
});
