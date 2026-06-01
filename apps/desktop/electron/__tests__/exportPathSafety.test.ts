/**
 * Regression tests for the export-path allowlist that backs the
 * `artifacts:exportToFile` and `artifacts:exportMarp` IPC handlers.
 *
 * The handlers used to honour any absolute path the renderer supplied,
 * which turned them into a write-anywhere primitive accessible from a
 * potentially-compromised renderer. The fix constrains the absolute-path
 * branch to an allowlist of user-controlled directories and rejects
 * everything else. These tests pin that contract directly on the helper
 * so it can never silently regress under a refactor.
 */
import { describe, it, expect } from "vitest";
import * as path from "path";
import * as os from "os";
import { isSafeExportPath } from "../exportPathSafety";

const isWin = process.platform === "win32";

// Use real OS-resolved paths so the tests run identically on Linux,
// macOS and Windows. We pick directories that are *guaranteed* to exist
// (or at least produce a stable absolute path) on every supported host.
const HOME = os.homedir();
const TMP = os.tmpdir();
const DOWNLOADS = path.join(HOME, "Downloads");
const DOCUMENTS = path.join(HOME, "Documents");

const ROOTS = [DOWNLOADS, DOCUMENTS, HOME, TMP];

describe("isSafeExportPath", () => {
  it("accepts a file directly inside an allowlisted root", () => {
    expect(isSafeExportPath(path.join(DOWNLOADS, "artifact.pdf"), ROOTS)).toBe(
      true,
    );
    expect(
      isSafeExportPath(path.join(DOCUMENTS, "sub", "deck.pptx"), ROOTS),
    ).toBe(true);
    expect(isSafeExportPath(path.join(TMP, "test.xlsx"), ROOTS)).toBe(true);
  });

  it("accepts the root directory itself", () => {
    expect(isSafeExportPath(DOWNLOADS, ROOTS)).toBe(true);
  });

  it("accepts paths nested arbitrarily deep under a root", () => {
    expect(
      isSafeExportPath(
        path.join(DOWNLOADS, "a", "b", "c", "d", "deep.pdf"),
        ROOTS,
      ),
    ).toBe(true);
  });

  it("rejects a path that escapes via .. segments", () => {
    // `~/Downloads/../../etc/passwd` normalises to `/etc/passwd` (or a
    // sibling), which is outside the allowlist.
    const escape = path.join(DOWNLOADS, "..", "..", "etc", "passwd");
    expect(isSafeExportPath(escape, ROOTS)).toBe(false);
  });

  it("rejects a sibling directory that shares a name prefix with a root", () => {
    // e.g. `/Users/me/Downloads2/x` must NOT be considered inside
    // `/Users/me/Downloads`. This is the classic `startsWith` pitfall.
    // We test the helper here against a *single* root (Downloads only)
    // rather than the full allowlist, because the full allowlist
    // includes the user's HOME and a `Downloads2` sibling lives inside
    // HOME — that legitimately resolves as safe. The pitfall the test
    // pins is the path-separator boundary inside the containment
    // check, not the full allowlist composition.
    const sibling = `${DOWNLOADS}2${path.sep}x`;
    expect(isSafeExportPath(sibling, [DOWNLOADS])).toBe(false);
  });

  it("rejects absolute system paths outside any root", () => {
    if (isWin) {
      expect(
        isSafeExportPath("C:\\Windows\\System32\\drivers\\etc\\hosts", ROOTS),
      ).toBe(false);
      expect(
        isSafeExportPath("C:\\ProgramData\\Microsoft\\out.pdf", ROOTS),
      ).toBe(false);
    } else {
      expect(isSafeExportPath("/etc/passwd", ROOTS)).toBe(false);
      expect(isSafeExportPath("/var/log/syslog", ROOTS)).toBe(false);
      expect(isSafeExportPath("/root/exfil.pdf", ROOTS)).toBe(false);
    }
  });

  it("rejects relative paths (fails closed)", () => {
    // The IPC handlers gate on `path.isAbsolute` *before* calling this
    // helper, but we still fail closed for relative paths so a future
    // refactor that removes the outer guard does not regress.
    expect(isSafeExportPath("artifact.pdf", ROOTS)).toBe(false);
    expect(isSafeExportPath("./sub/artifact.pdf", ROOTS)).toBe(false);
    expect(isSafeExportPath("../etc/passwd", ROOTS)).toBe(false);
  });

  it("rejects everything when the allowlist is empty", () => {
    expect(isSafeExportPath(path.join(DOWNLOADS, "x.pdf"), [])).toBe(false);
  });

  it("ignores empty string entries in the allowlist", () => {
    expect(
      isSafeExportPath(path.join(DOWNLOADS, "x.pdf"), ["", DOWNLOADS]),
    ).toBe(true);
    expect(isSafeExportPath(path.join(DOWNLOADS, "x.pdf"), [""])).toBe(false);
  });

  if (isWin) {
    it("compares case-insensitively on Windows", () => {
      const upperRoot = DOWNLOADS.toUpperCase();
      const lowerPath = path.join(DOWNLOADS, "x.pdf").toLowerCase();
      expect(isSafeExportPath(lowerPath, [upperRoot])).toBe(true);
    });
  }
});

// ----------------------------------------------------------------
// deny-list carves out KChat cache dirs
// ----------------------------------------------------------------

const KCHAT_CACHE = path.join(HOME, ".tessera", "kchat-channels");

describe("isSafeExportPath with denyRoots", () => {
  it("rejects a path inside the KChat channel cache even though it is inside HOME", () => {
    // Without the deny-list this would pass because HOME is in ROOTS.
    const target = path.join(KCHAT_CACHE, "chidabcdef1234567890abcd", "file.md");
    expect(isSafeExportPath(target, ROOTS, [KCHAT_CACHE])).toBe(false);
  });

  it("rejects the KChat cache root directory itself", () => {
    expect(isSafeExportPath(KCHAT_CACHE, ROOTS, [KCHAT_CACHE])).toBe(false);
  });

  it("rejects paths nested arbitrarily deep under a deny-root", () => {
    const deep = path.join(KCHAT_CACHE, "ch1", "sub", "deep", "x.pdf");
    expect(isSafeExportPath(deep, ROOTS, [KCHAT_CACHE])).toBe(false);
  });

  it("does not reject paths that share a prefix but are siblings of the deny-root", () => {
    // `~/.tessera/kchat-channels2/x.pdf` is NOT inside
    // `~/.tessera/kchat-channels/` — the separator check must
    // distinguish them.
    const sibling = `${KCHAT_CACHE}2${path.sep}x.pdf`;
    expect(isSafeExportPath(sibling, ROOTS, [KCHAT_CACHE])).toBe(true);
  });

  it("rejects paths that escape the deny-root via .. but resolve back inside it", () => {
    // `kchat-channels/foo/../../kchat-channels/bar/x` resolves to
    // `kchat-channels/bar/x` which is inside the deny-root.
    const escape = path.join(KCHAT_CACHE, "foo", "..", "..", "kchat-channels", "bar", "x.md");
    expect(isSafeExportPath(escape, ROOTS, [KCHAT_CACHE])).toBe(false);
  });

  it("still allows normal export paths when a deny-root is active", () => {
    // Downloads is not inside the deny-root.
    expect(
      isSafeExportPath(path.join(DOWNLOADS, "export.pdf"), ROOTS, [KCHAT_CACHE]),
    ).toBe(true);
    expect(
      isSafeExportPath(path.join(TMP, "test.xlsx"), ROOTS, [KCHAT_CACHE]),
    ).toBe(true);
  });

  it("rejects when path escapes allow-root even if deny-list is empty", () => {
    // Regression: the deny-list addition must not break the allow-list logic.
    const escape = path.join(DOWNLOADS, "..", "..", "etc", "passwd");
    expect(isSafeExportPath(escape, ROOTS, [])).toBe(false);
  });

  it("rejects everything when deny-root covers the allow-root", () => {
    // If HOME is both allowed AND denied, deny wins.
    expect(
      isSafeExportPath(path.join(HOME, "file.pdf"), [HOME], [HOME]),
    ).toBe(false);
  });

  it("ignores empty string entries in the deny-list", () => {
    // An empty deny entry must not cause false-reject (an empty string
    // `path.resolve("")` is cwd, which is typically inside HOME).
    expect(
      isSafeExportPath(path.join(DOWNLOADS, "ok.pdf"), ROOTS, [""]),
    ).toBe(true);
  });
});
