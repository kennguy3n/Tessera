/**
 * Path-safety guard for the artifact export IPC handlers.
 *
 * The renderer process is treated as untrusted: a compromised renderer could
 * send an arbitrary absolute file path to `artifacts:exportToFile` or
 * `artifacts:exportMarp` and turn either handler into a write-anywhere
 * primitive (e.g. clobbering `/etc/passwd` or `C:\Windows\System32\drivers\...`).
 *
 * `isSafeExportPath` constrains the renderer-supplied absolute path to a
 * fixed allowlist of user-controlled directories — the user's Downloads,
 * Documents, Desktop, home, the Electron app's `userData` directory, and
 * the OS temp directory (which the integration test harness uses). Anything
 * outside that allowlist is rejected by the IPC handler with an explicit
 * error rather than silently honoured.
 *
 * The function is split out of `ipc.ts` so it can be unit-tested without
 * having to spin up an Electron `app` / `BrowserWindow` (see
 * `__tests__/exportPathSafety.test.ts`). All `..`/`.` segments and trailing
 * separators are normalised through `path.resolve` before the prefix check
 * so a request like `Downloads/../../../etc/passwd` cannot dodge the gate.
 *
 * Symlinks: we deliberately do NOT call `fs.realpath` here. The export path
 * is typically the *target* of the write and may not yet exist, so a
 * `realpath` round-trip would either error or fall back to a partial
 * resolve. The threat we are blocking is a renderer choosing a path; if an
 * attacker can already drop a symlink inside `~/Downloads` they have a
 * different problem. A future hardening pass can `realpath` the parent
 * directory and re-check, but that's out of scope for the current fix.
 */

import * as path from "path";

/**
 * Returns true if `requestedPath` resolves to a location inside one of
 * `safeRoots`. Both `requestedPath` and each entry of `safeRoots` are
 * resolved through `path.resolve` so callers do not have to pre-normalise.
 *
 * `requestedPath` must be absolute — pass through `path.isAbsolute` at the
 * call site. The function returns `false` (not `true`) for relative paths
 * so a programming mistake fails closed.
 *
 * `safeRoots` should be a non-empty list of canonical absolute directory
 * paths. An empty list always returns `false`.
 *
 * `denyRoots` (optional) is a list of absolute directory paths that are
 * NEVER allowed as export targets, even if they fall inside a `safeRoot`.
 * The deny-list is checked after the allow-list match — a path that lands
 * inside both an allow-root and a deny-root is rejected. This lets
 * callers carve out sensitive subtrees (e.g. the KChat channel cache
 * under `~/.tessera/kchat-channels/`) from a broad allow-root like HOME.
 */
export function isSafeExportPath(
  requestedPath: string,
  safeRoots: readonly string[],
  denyRoots: readonly string[] = [],
): boolean {
  if (!path.isAbsolute(requestedPath)) {
    return false;
  }
  if (safeRoots.length === 0) {
    return false;
  }

  // `path.resolve` collapses `..` / `.` segments and normalises separators
  // for the current platform. Without this normalisation a path like
  // `/Users/me/Downloads/../../etc/passwd` would naïvely match the
  // Downloads prefix even though it escapes that directory.
  const normalisedRequested = path.resolve(requestedPath);

  // Deny-list takes precedence: if the path is inside any deny-root,
  // reject immediately regardless of allow-root membership.
  for (const deny of denyRoots) {
    if (!deny) continue;
    const normalisedDeny = path.resolve(deny);
    if (isPathInsideRoot(normalisedRequested, normalisedDeny)) {
      return false;
    }
  }

  for (const root of safeRoots) {
    if (!root) continue;
    const normalisedRoot = path.resolve(root);
    if (isPathInsideRoot(normalisedRequested, normalisedRoot)) {
      return true;
    }
  }
  return false;
}

/**
 * Strict containment check: `candidate` is inside `root` iff:
 *   1. They are exactly equal, OR
 *   2. `candidate` starts with `root` followed by a path separator.
 *
 * Plain string `startsWith` is NOT enough — `"/Users/me/Downloads2"`
 * starts with `"/Users/me/Downloads"` but is a sibling directory, not a
 * child. The trailing-separator check disambiguates that case.
 *
 * On Windows the comparison is case-insensitive (NTFS is case-preserving
 * but case-insensitive by default) and uses the platform separator from
 * `path.sep`.
 */
function isPathInsideRoot(candidate: string, root: string): boolean {
  const isWin = process.platform === "win32";
  const cmpCandidate = isWin ? candidate.toLowerCase() : candidate;
  const cmpRoot = isWin ? root.toLowerCase() : root;

  if (cmpCandidate === cmpRoot) {
    return true;
  }
  const withSep = cmpRoot.endsWith(path.sep) ? cmpRoot : cmpRoot + path.sep;
  return cmpCandidate.startsWith(withSep);
}
