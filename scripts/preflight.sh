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

# Always run from the repo root so relative paths in cargo / npm /
# electron-builder resolve correctly even when the script is invoked
# from a subdirectory.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

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

# Step counter so the user sees "1/6", "2/6", ... headers. The total
# is recomputed at start so it stays correct even when steps are
# skipped via env vars.
STEP_INDEX=0
STEP_TOTAL=0
declare -a PREFLIGHT_STEPS=()

# Registers a step. Each step is described by a label and a shell
# command (single string, evaluated later). We collect all of them
# up front so we can show "1/N" / "2/N" headers.
register_step() {
  local label="$1"
  local cmd="$2"
  PREFLIGHT_STEPS+=("${label}|${cmd}")
}

# Runs all registered steps in order. On failure prints a clear
# "FAILED" header pointing at the offending step and exits with the
# step's own exit code so CI tooling can diagnose.
run_steps() {
  STEP_TOTAL="${#PREFLIGHT_STEPS[@]}"
  for entry in "${PREFLIGHT_STEPS[@]}"; do
    STEP_INDEX=$((STEP_INDEX + 1))
    local label="${entry%%|*}"
    local cmd="${entry#*|}"
    printf '\n%s[%d/%d] %s%s\n' "${C_BOLD}" "${STEP_INDEX}" "${STEP_TOTAL}" "${label}" "${C_RESET}"
    printf '%s    %s%s\n' "${C_DIM}" "${cmd}" "${C_RESET}"
    # `set -e` would abort the whole script on the first failure
    # before we can print the failure banner, so we explicitly
    # disable it for the duration of the step and check $? ourselves.
    set +e
    bash -o pipefail -c "${cmd}"
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

detect_version() {
  if [[ -n "${TESSERA_PREFLIGHT_VERSION:-}" ]]; then
    printf '%s' "${TESSERA_PREFLIGHT_VERSION}"
    return
  fi
  # Read the top-level package.json `version` field. We avoid pulling
  # in `jq` to keep preflight runnable on a bare clone.
  local v
  v="$(node -e "console.log(require('./package.json').version)" 2>/dev/null || true)"
  if [[ -z "${v}" ]]; then
    # Fallback to a regex if Node is missing. Preflight needs Node
    # for the desktop build anyway, but this keeps the version
    # detection from being the failing step.
    v="$(grep -E '"version"' package.json | head -n1 | sed -E 's/.*"version"[^"]*"([^"]+)".*/\1/')"
  fi
  printf '%s' "${v:-X.Y.Z}"
}

# ----------------------------------------------------------------------
# Step registration
# ----------------------------------------------------------------------

# 1) Rust workspace tests — mirrors `npm run test:rust` and the CI
#    Rust matrix. We run with `--all` so every crate's tests execute.
register_step "Rust tests (cargo test --all)" \
  "cargo test --all"

# 2) Desktop renderer / Electron lint — same command CI runs.
register_step "Desktop lint (npm run lint --workspace=apps/desktop)" \
  "npm run lint --workspace=apps/desktop"

# 3) Desktop TypeScript type-check.
register_step "Desktop type-check (npm run type-check --workspace=apps/desktop)" \
  "npm run type-check --workspace=apps/desktop"

# 4) Desktop unit / component tests (Vitest).
register_step "Desktop tests (npm run test --workspace=apps/desktop)" \
  "npm run test --workspace=apps/desktop"

# 5) Build the bundle electron-builder will consume. Without this,
#    `electron-builder --dir` would package whatever stale renderer /
#    main bundles happen to be on disk, which defeats the purpose of
#    a release dry-run.
register_step "Desktop build (npm run build --workspace=apps/desktop)" \
  "npm run build --workspace=apps/desktop"

# 6) electron-builder dry-pack. `--dir` skips the installer step
#    (no .dmg / .exe / .AppImage produced) but still assembles the
#    full app bundle, so we catch packaging regressions (missing
#    files, broken extraResources, native asar issues) before
#    pushing a release tag.
if [[ "${TESSERA_PREFLIGHT_SKIP_PACKAGE:-0}" != "1" ]]; then
  register_step "Electron bundle dry-pack (electron-builder --dir)" \
    "npx --no-install electron-builder --config packaging/electron-builder.yml --dir"
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
