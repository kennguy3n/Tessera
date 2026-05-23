#!/usr/bin/env bash
#
# Tessera pre-release preflight.
#
# Runs every gate that CI runs before a tagged release, plus an
# `electron-builder --dir` dry-pack so we catch packaging regressions
# before pushing a `v*` tag (which would trigger the real release
# workflow). Each step is wrapped so a failure shows the failing
# step name and the script exits non-zero — no silent skips.
#
# Usage:
#   scripts/preflight.sh
#
# Exit codes:
#   0 — every step passed; safe to tag the version printed in the
#       final summary line.
#   non-zero — first failing step's exit code (see the per-step
#       headers in the output for the failing step name).
#
# Environment overrides (advanced):
#   TESSERA_PREFLIGHT_SKIP_PACKAGE=1  skip the electron-builder
#       --dir step (useful on CI or contributor machines that
#       can't run electron-builder; CI does its own packaging
#       in the release workflow either way).
#   TESSERA_PREFLIGHT_VERSION=x.y.z   override the version string
#       used in the final "ready to tag" summary; defaults to the
#       `version` field in package.json.

set -euo pipefail

# Mirror the CI workflow's global RUSTFLAGS (the workflow-level
# `env:` block in .github/workflows/ci.yml). Without this,
# `cargo test --all` (and any plain `cargo build` it triggers) would
# only emit warnings while CI treats those same warnings as errors —
# a release-day surprise we exist to prevent. We append rather than
# overwrite so a developer's pre-existing RUSTFLAGS (e.g. for
# target-cpu tuning) is preserved.
# Detect whether the user already has `-D warnings` in their
# RUSTFLAGS — if so we leave the value untouched rather than emitting
# `... -D warnings -D warnings`. rustc deduplicates flags so the
# duplicate is harmless, but the noisy string shows up in CI logs and
# in `cargo` error messages, and the dedup is cheap.
#
# rustc accepts BOTH the spaced form `-D warnings` and the spaceless
# form `-Dwarnings`, so the regex uses `[[:space:]]*` (zero-or-more
# whitespace between `-D` and `warnings`) to match either. Token
# boundaries on the outside (`(^|[[:space:]])` and `([[:space:]]|$)`)
# still prevent false positives on e.g. `-D warnings-as-deny` (the
# trailing `-` is not whitespace) or `-Dfoowarnings` (the `D` would
# need to be preceded by `foo`, which isn't whitespace).
if [[ "${RUSTFLAGS:-}" =~ (^|[[:space:]])-D[[:space:]]*warnings([[:space:]]|$) ]]; then
  # Already contains `-D warnings` — keep the existing value as-is,
  # but make sure it's exported so the subshell inherits it.
  export RUSTFLAGS
elif [[ -n "${RUSTFLAGS:-}" ]]; then
  export RUSTFLAGS="${RUSTFLAGS} -D warnings"
else
  export RUSTFLAGS="-D warnings"
fi

# Always run from the repo root so relative paths in cargo / npm /
# electron-builder resolve correctly even when the script is invoked
# from a subdirectory.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

# Fail-fast on Windows-flavoured `bash` (Git Bash / MSYS2 / Cygwin).
# The supported entrypoint on Windows is `scripts/preflight.ps1` —
# RELEASING.md directs Windows users there, the Rollup workaround
# below only knows about Darwin uname strings, and the
# Windows-specific Rollup binary (`@rollup/rollup-win32-x64-msvc`)
# is installed by the PowerShell sibling. Without this guard, a
# Windows user running `bash scripts/preflight.sh` from Git Bash
# would see the Rollup step silently skipped (the `case` statement
# defaults to empty for `MINGW64_NT-*` / `MSYS_NT-*` / `CYGWIN_NT-*`),
# then hit a confusing "Cannot find module @rollup/rollup-win32-x64-msvc"
# error several minutes later during `vite build`. Surfacing the
# mismatch up front saves the wait and points to the right tool.
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    printf '%spreflight.sh is not supported on Windows.%s\n' \
      "${C_BOLD:-}" "${C_RESET:-}" >&2
    printf 'Run the PowerShell sibling instead:\n\n' >&2
    printf '    powershell -ExecutionPolicy Bypass -File scripts\\preflight.ps1\n\n' >&2
    printf '(or `.\\scripts\\preflight.ps1` from a PowerShell prompt).\n' >&2
    exit 2
    ;;
esac

# ----------------------------------------------------------------------
# Output helpers
# ----------------------------------------------------------------------

# ANSI colours when stdout is a TTY; plain otherwise so CI logs stay
# greppable.
if [[ -t 1 ]]; then
  C_BOLD=$'\033[1m'
  C_GREEN=$'\033[32m'
  C_RED=$'\033[31m'
  C_DIM=$'\033[2m'
  C_RESET=$'\033[0m'
else
  C_BOLD=""
  C_GREEN=""
  C_RED=""
  C_DIM=""
  C_RESET=""
fi

# Step counter so the user sees "1/N", "2/N", ... headers. The total
# is recomputed at start so it stays correct even when steps are
# skipped via env vars.
STEP_INDEX=0
STEP_TOTAL=0

# Parallel arrays. We deliberately avoid a single delimiter-joined
# string because step *commands* commonly contain shell metacharacters
# (pipes, ampersands, `--`, etc.) and any single ASCII delimiter would
# either need escaping at every call site or risk silently truncating
# the command at the first occurrence.
declare -a PREFLIGHT_STEP_LABELS=()
declare -a PREFLIGHT_STEP_COMMANDS=()

# Registers a step. Each step is described by a label and a shell
# command (single string, evaluated later). We collect all of them
# up front so we can show "1/N" / "2/N" headers.
register_step() {
  local label="$1"
  local cmd="$2"
  PREFLIGHT_STEP_LABELS+=("${label}")
  PREFLIGHT_STEP_COMMANDS+=("${cmd}")
}

# Runs all registered steps in order. On failure prints a clear
# "FAILED" header pointing at the offending step and exits with the
# step's own exit code so CI tooling can diagnose.
run_steps() {
  STEP_TOTAL="${#PREFLIGHT_STEP_LABELS[@]}"
  local i
  for (( i = 0; i < STEP_TOTAL; i++ )); do
    STEP_INDEX=$((i + 1))
    local label="${PREFLIGHT_STEP_LABELS[$i]}"
    local cmd="${PREFLIGHT_STEP_COMMANDS[$i]}"
    printf '\n%s[%d/%d] %s%s\n' "${C_BOLD}" "${STEP_INDEX}" "${STEP_TOTAL}" "${label}" "${C_RESET}"
    printf '%s    %s%s\n' "${C_DIM}" "${cmd}" "${C_RESET}"
    # `set -e` in the *parent* shell would abort the script on the
    # first failure before we can print the failure banner, so we
    # explicitly disable it for the duration of the step and check
    # the subshell's exit code ourselves.
    #
    # The subshell, however, gets `-e -u -o pipefail` so it mirrors
    # the parent's `set -euo pipefail` strictness exactly:
    #   * `-o pipefail` makes a piped step (e.g. `foo | grep`) fail
    #     when any element of the pipeline fails, not just the last.
    #   * `-e` makes a multi-statement step (e.g. `cmd1; cmd2`) fail
    #     as soon as the first statement returns non-zero, instead of
    #     silently masking it and reporting only the final exit code.
    #   * `-u` makes an unset-variable reference inside a step (e.g.
    #     `echo "$RUSTFLAGS_NEW"` when the variable was never set)
    #     fail loudly instead of silently expanding to the empty
    #     string and letting the surrounding command run with a
    #     misleading argument list.
    # Without these, a step like `cargo build; cargo test` would let
    # a broken build slip through if the (separate, unrelated) test
    # run later happened to succeed — a class of bug the preflight
    # gate exists to prevent. Today every step is a single string
    # literal with no variable references so the behaviour change is
    # theoretical, but enabling all three now guarantees the property
    # holds for any step a future maintainer adds.
    set +e
    bash -e -u -o pipefail -c "${cmd}"
    local rc=$?
    set -e
    if [[ "${rc}" -ne 0 ]]; then
      printf '\n%s%sFAILED%s at step %d/%d: %s (exit %d)\n' \
        "${C_BOLD}" "${C_RED}" "${C_RESET}" \
        "${STEP_INDEX}" "${STEP_TOTAL}" "${label}" "${rc}"
      exit "${rc}"
    fi
  done
}

# ----------------------------------------------------------------------
# Version detection
# ----------------------------------------------------------------------

# Returns 0 if $1 is a usable version string (non-empty and not the
# stringified JS sentinels `undefined`/`null` that `console.log` would
# emit if package.json had no version field). Used by detect_version
# below; factored out so both the node-based and regex-based fallbacks
# get the same sanity check.
is_valid_version() {
  local v="$1"
  [[ -n "${v}" && "${v}" != "undefined" && "${v}" != "null" ]]
}

detect_version() {
  # Honour the explicit override first, but run it through the same
  # is_valid_version filter the rest of this function uses for the
  # package.json/regex paths. The PowerShell sibling (preflight.ps1's
  # Get-PreflightVersion) gates $env:TESSERA_PREFLIGHT_VERSION through
  # Test-VersionUsable, which strips the JS sentinels `"undefined"`
  # and `"null"`; matching that behaviour here keeps the two scripts
  # identical for a user who deliberately or accidentally exports
  # `TESSERA_PREFLIGHT_VERSION=undefined` (e.g. as the result of a
  # shell pipeline like `export TESSERA_PREFLIGHT_VERSION=$(jq -r
  # .version package.json)` against a package.json that lacks the
  # field). Without this filter, bash would happily print "vundefined"
  # in the final banner while PowerShell would fall back to the
  # package.json read — a confusing cross-platform asymmetry. After
  # the filter, an invalid override falls through to the package.json
  # and regex paths just like the no-override case.
  if is_valid_version "${TESSERA_PREFLIGHT_VERSION:-}"; then
    printf '%s' "${TESSERA_PREFLIGHT_VERSION}"
    return
  fi
  # Read the top-level package.json `version` field. We avoid pulling
  # in `jq` to keep preflight runnable on a bare clone.
  local v
  v="$(node -e "console.log(require('./package.json').version)" 2>/dev/null || true)"
  if ! is_valid_version "${v}"; then
    # Fallback to a regex if Node is missing OR if Node returned the
    # JS sentinel "undefined"/"null" (which would happen if the
    # package.json had no `version` field). Preflight needs Node for
    # the desktop build anyway, but this keeps the version detection
    # from emitting a bogus "vundefined" banner.
    v="$(grep -E '"version"' package.json | head -n1 | sed -E 's/.*"version"[^"]*"([^"]+)".*/\1/')"
  fi
  if is_valid_version "${v}"; then
    printf '%s' "${v}"
  else
    printf '%s' "X.Y.Z"
  fi
}

# ----------------------------------------------------------------------
# Step registration
# ----------------------------------------------------------------------

# 1) Rust formatting check — same command the CI workflow runs in
#    the "Check formatting" step of the `rust` job.
register_step "Rust format check (cargo fmt --all -- --check)" \
  "cargo fmt --all -- --check"

# 2) Rust clippy with warnings-as-errors — same command the CI
#    workflow runs in the "Clippy" step of the `rust` job
#    (RUSTFLAGS="-D warnings" is set globally in the workflow's
#    top-level `env:` block; we propagate it above).
register_step "Rust clippy (cargo clippy --all-targets --all-features -- -D warnings)" \
  "cargo clippy --all-targets --all-features -- -D warnings"

# 3) Rust workspace tests — mirrors `npm run test:rust` and the CI
#    Rust matrix. We run with `--all` so every crate's tests execute.
register_step "Rust tests (cargo test --all)" \
  "cargo test --all"

# 4) Desktop renderer / Electron lint — same command CI runs.
register_step "Desktop lint (npm run lint --workspace=apps/desktop)" \
  "npm run lint --workspace=apps/desktop"

# 5) Desktop TypeScript type-check.
register_step "Desktop type-check (npm run type-check --workspace=apps/desktop)" \
  "npm run type-check --workspace=apps/desktop"

# 6) Desktop unit / component tests (Vitest).
register_step "Desktop tests (npm run test --workspace=apps/desktop)" \
  "npm run test --workspace=apps/desktop"

# 7) Workaround for npm/cli#4828: Rollup ships per-platform native
#    binaries as optionalDependencies (e.g. `@rollup/rollup-darwin-arm64`),
#    and `npm ci` does NOT always install the binary matching the
#    current host when the lockfile was generated on a different OS.
#    The Vite-driven `npm run build` step below depends on Rollup at
#    runtime, so without the host-matching binary the build fails with
#    a confusing "Cannot find module @rollup/rollup-<plat>-<arch>"
#    error.
#
#    Scope: this step ONLY runs on macOS and Windows hosts — Linux is
#    skipped on purpose. Rationale:
#
#      * The committed `package-lock.json` is generated on Linux, so
#        `npm ci` already installs `@rollup/rollup-linux-x64-gnu` /
#        `@rollup/rollup-linux-arm64-gnu` directly from the lockfile.
#        The npm/cli#4828 bug only affects the foreign-OS case.
#      * `.github/workflows/ci.yml` runs the workaround only for the
#        macos-13 and windows-2022 matrix legs (the Linux leg skips
#        it), and so does `.github/workflows/release.yml`. Running an
#        extra install on Linux preflight that CI doesn't would
#        create a behaviour gap between the gates and could mask
#        Linux-specific lockfile bugs that CI is supposed to catch.
#      * RELEASING.md documents this as a macOS/Windows-only step;
#        keeping the script in lock-step with the docs avoids
#        confusing maintainers ("docs say 8 steps on Linux but I see
#        9").
#
#    The package name follows the convention
#    `@rollup/rollup-<plat>-<arch>[-<libc>]`. We pick it from
#    `uname -s` × `uname -m`, mapping the macOS x86_64 / arm64 cases
#    explicitly. If the host is a platform we don't ship for, we
#    skip the install rather than fail — `npm install` against a
#    non-existent package would just add a confusing failure to the
#    run.
#
#    See https://github.com/npm/cli/issues/4828 for the underlying
#    npm bug; this workaround (here, in ci.yml, and in release.yml)
#    can be removed once that issue is fixed and the minimum npm in
#    CONTRIBUTING.md is bumped past the fix.
__os="$(uname -s)"
__arch="$(uname -m)"
case "${__os}-${__arch}" in
  Darwin-x86_64)  ROLLUP_HOST_BINARY="@rollup/rollup-darwin-x64" ;;
  Darwin-arm64)   ROLLUP_HOST_BINARY="@rollup/rollup-darwin-arm64" ;;
  *)              ROLLUP_HOST_BINARY="" ;;
esac
unset __os __arch
if [[ -n "${ROLLUP_HOST_BINARY}" ]]; then
  register_step "Install host Rollup binary (${ROLLUP_HOST_BINARY})" \
    "npm install --no-save --no-package-lock ${ROLLUP_HOST_BINARY}"
fi

# 8) Build the bundle electron-builder will consume. Without this,
#    `electron-builder --dir` would package whatever stale renderer /
#    main bundles happen to be on disk, which defeats the purpose of
#    a release dry-run.
#
#    We deliberately invoke the *root-level* `npm run build` script
#    (which currently forwards to `npm run build --workspace=apps/desktop`
#    via the `build` entry in the top-level package.json) rather than
#    targeting the workspace directly. This keeps preflight in lock-step
#    with `.github/workflows/release.yml` (which runs the same root
#    `npm run build` at release.yml:111). The earlier `lint` /
#    `type-check` / `test` steps stay workspace-scoped because
#    `.github/workflows/ci.yml` runs them workspace-scoped (lines
#    160 / 163 / 166); only the desktop build is asymmetric, and the
#    fix lives here. If the root `build` script later grows additional
#    steps (e.g. is changed to
#    `npm run build:native && npm run build --workspace=apps/desktop`
#    once apps/desktop/package.json's placeholder `build:native` is
#    promoted into the chain), preflight will automatically exercise
#    them too. Calling the workspace command directly here would have
#    masked that transition until a release-day failure surfaced it.
register_step "Desktop build (npm run build)" \
  "npm run build"

# 9) electron-builder dry-pack. `--dir` skips the installer step
#    (no .dmg / .exe / .AppImage produced) but still assembles the
#    full app bundle, so we catch packaging regressions (missing
#    files, broken extraResources, native asar issues) before
#    pushing a release tag.
if [[ "${TESSERA_PREFLIGHT_SKIP_PACKAGE:-0}" != "1" ]]; then
  # `--no` is the npm 10+ canonical form of "refuse to install if the
  # binary isn't already present" (`npm exec --help` documents it as
  # the opposite of `--yes`). The historical `--no-install` flag from
  # standalone-npx (pre-npm 7) is still accepted today as a backward-
  # compat alias, but some intermediate npm versions silently ignored
  # it, so the canonical form is safer for long-lived scripts. The
  # release workflow at .github/workflows/release.yml and the
  # PowerShell sibling at scripts/preflight.ps1 carry the same change.
  register_step "Electron bundle dry-pack (electron-builder --dir)" \
    "npx --no electron-builder --config packaging/electron-builder.yml --dir"
fi

# ----------------------------------------------------------------------
# Run
# ----------------------------------------------------------------------

VERSION="$(detect_version)"
printf '%sTessera preflight%s — version %sv%s%s\n' \
  "${C_BOLD}" "${C_RESET}" "${C_BOLD}" "${VERSION}" "${C_RESET}"

run_steps

printf '\n%s%sPreflight passed%s — ready to tag %sv%s%s\n' \
  "${C_BOLD}" "${C_GREEN}" "${C_RESET}" \
  "${C_BOLD}" "${VERSION}" "${C_RESET}"
