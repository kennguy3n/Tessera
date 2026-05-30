#!/usr/bin/env bash
#
# Phase 15 Task 16 — Linux .deb / AppImage smoke harness.
#
# This script builds the .deb + AppImage via electron-builder, installs the
# .deb in an Ubuntu 22.04 Docker container, and launches the app headlessly
# under xvfb to confirm that:
#
#   1. Electron's `ready` event fires (i.e. the main process starts without
#      a missing-library or missing-binary crash on a clean Ubuntu base).
#   2. One IPC round-trip succeeds (`sources:list`) so we know the Rust
#      bridge `tessera_bridge.linux-x64-gnu.node` loaded and the napi
#      surface answers.
#
# The script is the test: exit code 0 = pass, non-zero = fail.
#
# Wired into `npm run test:smoke:linux` at the repo root.
#
# Required tools on the host:
#   * docker (for the Ubuntu 22.04 container)
#   * Node 20+ and electron-builder available via the workspace install
#
# Environment overrides:
#   SMOKE_SKIP_BUILD=1     — reuse whatever sits in `dist/linux/` already.
#                            Useful in CI where a previous job already built
#                            the .deb and we just want the smoke phase.
#   SMOKE_DOCKER_IMAGE=... — alternative base image (default
#                            `ubuntu:22.04`).
#   SMOKE_TIMEOUT_SECS=30  — how long to wait for the `ready` event before
#                            failing.
#
# References:
#   * packaging/linux/electron-builder-linux.yml
#   * scripts/Dockerfile.smoke
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

DOCKER_IMAGE="${SMOKE_DOCKER_IMAGE:-ubuntu:22.04}"
SMOKE_TIMEOUT_SECS="${SMOKE_TIMEOUT_SECS:-30}"

echo "==> Tessera Linux smoke harness"
echo "    repo root        : $REPO_ROOT"
echo "    docker base image: $DOCKER_IMAGE"
echo "    ready timeout    : ${SMOKE_TIMEOUT_SECS}s"

# ----------------------------------------------------------------------------
# Step 1 — build .deb + AppImage (skippable via SMOKE_SKIP_BUILD=1).
# ----------------------------------------------------------------------------
if [[ "${SMOKE_SKIP_BUILD:-0}" == "1" ]]; then
  echo "==> SMOKE_SKIP_BUILD=1 — reusing existing dist/linux/ artifacts"
else
  echo "==> Building Linux packages via electron-builder"
  # The renderer + electron bundles must exist before electron-builder runs;
  # `npm run build --workspace=apps/desktop` produces them.
  (cd apps/desktop && npm run build)
  npx --no-install electron-builder \
    --linux \
    --config packaging/linux/electron-builder-linux.yml
fi

# ----------------------------------------------------------------------------
# Step 2 — locate the produced .deb (x64 build is sufficient for the smoke).
# We deliberately pick the x64 .deb because the smoke container is x64.
# ----------------------------------------------------------------------------
DEB_PATH=$(find dist/linux -maxdepth 2 -type f -name 'Tessera_*_amd64.deb' | sort | tail -n1 || true)
if [[ -z "$DEB_PATH" ]]; then
  echo "ERROR: no Tessera_*_amd64.deb produced under dist/linux/" >&2
  echo "       check the electron-builder output above for the failure" >&2
  exit 2
fi
echo "==> Using .deb: $DEB_PATH"

APPIMAGE_PATH=$(find dist/linux -maxdepth 2 -type f -name 'Tessera-*-x86_64.AppImage' | sort | tail -n1 || true)
if [[ -z "$APPIMAGE_PATH" ]]; then
  echo "WARN: no x64 AppImage produced under dist/linux/ — the .deb path will still be smoked, but AppImage parity is untested."
else
  echo "==> Found AppImage: $APPIMAGE_PATH (verified existence only — .deb is the smoked install path)"
fi

# ----------------------------------------------------------------------------
# Step 3 — run the smoke container.
#
# The Dockerfile.smoke image:
#   * installs xvfb + every runtime .so we depend on (gtk, nss, secret, etc.)
#   * installs the .deb we just built
#   * runs `/usr/bin/tessera` under xvfb with a probe argv that asks the
#     main process to (a) wait for `ready`, (b) round-trip a single IPC
#     call, (c) print a probe JSON line, (d) quit.
#
# The probe is implemented as `scripts/electron-smoke-probe.cjs`, baked into
# the image and invoked via Electron's `--require` mechanism.
# ----------------------------------------------------------------------------
echo "==> Building smoke container"
docker build \
  --build-arg BASE_IMAGE="$DOCKER_IMAGE" \
  -f scripts/Dockerfile.smoke \
  -t tessera-linux-smoke:latest \
  --quiet \
  scripts/ >/dev/null

echo "==> Running smoke container with .deb mounted in"
DEB_BASENAME=$(basename "$DEB_PATH")
SMOKE_LOG=$(mktemp)
trap 'rm -f "$SMOKE_LOG"' EXIT

# Note: --shm-size=512m avoids the well-documented Electron/Chromium "MAP_FAILED
# /dev/shm" crash inside Docker containers with the default 64m /dev/shm.
set +e
docker run \
  --rm \
  --shm-size=512m \
  -e SMOKE_TIMEOUT_SECS="$SMOKE_TIMEOUT_SECS" \
  -v "$DEB_PATH:/tmp/$DEB_BASENAME:ro" \
  tessera-linux-smoke:latest \
  /tmp/"$DEB_BASENAME" \
  > "$SMOKE_LOG" 2>&1
SMOKE_EXIT=$?
set -e

echo "----- smoke container log -----"
cat "$SMOKE_LOG"
echo "-------------------------------"

if [[ $SMOKE_EXIT -ne 0 ]]; then
  echo "ERROR: smoke container exited $SMOKE_EXIT" >&2
  exit $SMOKE_EXIT
fi

# Final assertion: the probe writes a single-line marker on success. The
# absence of the marker (even with a 0 exit code) is treated as failure
# because Electron under xvfb can sometimes exit 0 on a renderer crash.
if ! grep -q '"smoke":"ok"' "$SMOKE_LOG"; then
  echo "ERROR: smoke marker '\"smoke\":\"ok\"' not present in container log" >&2
  exit 3
fi

echo "==> SMOKE PASS — .deb installs cleanly, app reaches ready, IPC round-trips"
