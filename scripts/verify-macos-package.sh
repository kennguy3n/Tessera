#!/usr/bin/env bash
#
# Phase 15 Task 18 — macOS packaging verification.
#
# The Tessera macOS build (packaging/macos/electron-builder-mac.yml) is
# configured to emit two architecture-specific DMGs (`x64`, `arm64`). The
# task spec allows either:
#
#   (a) a single universal .app bundle whose Mach-O binaries contain both
#       x86_64 + arm64 slices (verified via `lipo -info` returning
#       "x86_64 arm64"), OR
#   (b) two separate DMGs whose native addons each carry the matching
#       single-architecture slice.
#
# We accept both layouts. The verifier walks the dist/macos/ folder, mounts
# whichever DMGs are present, locates the native bridge addon
# (`tessera_bridge.darwin-{x64,arm64}.node`), runs `lipo -info` against it,
# and asserts the slice composition is correct for the DMG's architecture.
#
# Required tools:
#   * lipo            (ships with macOS / Xcode CLT)
#   * hdiutil         (ships with macOS)
#   * file            (ships with macOS)
#
# Script is the test. Non-zero exit = fail.
#
# Invocation (from repo root, on macOS):
#   bash scripts/verify-macos-package.sh
#
# Environment overrides:
#   TESSERA_DIST_DIR — dist root (default `dist/macos`).
#
# References:
#   * packaging/macos/electron-builder-mac.yml
#   * scripts/verify-windows-package.ps1 (sibling — Windows parity)
#   * scripts/smoke-test-linux.sh (sibling — Linux parity)
set -euo pipefail

DIST_DIR="${TESSERA_DIST_DIR:-dist/macos}"

echo "==> Tessera macOS package verifier"
echo "    dist dir: $DIST_DIR"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "WARN: not running on macOS — the lipo and hdiutil checks will fail."
  echo "      This script is intended for CI macOS runners only."
fi

for tool in lipo hdiutil file; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "ERROR: required tool '$tool' not on PATH" >&2
    exit 2
  fi
done

if [[ ! -d "$DIST_DIR" ]]; then
  echo "ERROR: dist directory does not exist: $DIST_DIR (run electron-builder --mac first)" >&2
  exit 3
fi

# ----------------------------------------------------------------------------
# Step 1 — enumerate produced DMGs. We expect at least one; the YAML emits
# two by default (x64 + arm64). Both naming patterns are tolerated to keep
# the verifier robust against future renames.
# ----------------------------------------------------------------------------
shopt -s nullglob
dmgs=("$DIST_DIR"/Tessera-*-x64.dmg "$DIST_DIR"/Tessera-*-arm64.dmg "$DIST_DIR"/Tessera-*-universal.dmg)
shopt -u nullglob

if [[ ${#dmgs[@]} -eq 0 ]]; then
  echo "ERROR: no Tessera-*.dmg artifacts under $DIST_DIR" >&2
  echo "       expected one or more of: Tessera-<ver>-x64.dmg, Tessera-<ver>-arm64.dmg, Tessera-<ver>-universal.dmg" >&2
  exit 4
fi

echo "==> found ${#dmgs[@]} DMG(s):"
for d in "${dmgs[@]}"; do
  printf "    %s\n" "$d"
done

# Track per-arch coverage so we can fail loudly if neither x64 nor arm64
# was produced. The packaging config requires BOTH; a build that emits only
# one is a regression.
saw_x64=0
saw_arm64=0
saw_universal=0

for dmg in "${dmgs[@]}"; do
  echo ""
  echo "==> verifying $(basename "$dmg")"

  mount_dir="$(mktemp -d)"
  # Detach on exit regardless of which subshell errored.
  trap 'hdiutil detach "$mount_dir" -quiet -force 2>/dev/null || true; rm -rf "$mount_dir"' RETURN

  hdiutil attach "$dmg" -mountpoint "$mount_dir" -nobrowse -readonly -quiet

  # Locate the .app bundle. electron-builder produces `Tessera.app/`.
  app_path=$(find "$mount_dir" -maxdepth 2 -type d -name 'Tessera.app' | head -n1 || true)
  if [[ -z "$app_path" ]]; then
    echo "ERROR: Tessera.app not found inside $(basename "$dmg")" >&2
    hdiutil detach "$mount_dir" -quiet -force 2>/dev/null || true
    exit 5
  fi
  echo "    .app: $app_path"

  # Locate the native bridge addon inside the .app. electron-builder places
  # asar-unpacked native modules under Contents/Resources/app.asar.unpacked/
  # when the asarUnpack glob matches `native/**/*.node`.
  addon=$(find "$app_path" -type f -name 'tessera_bridge.darwin-*.node' | head -n1 || true)
  if [[ -z "$addon" ]]; then
    # Fallback: any .node file under the .app — the napi-rs basename can vary
    # by release version (e.g. `tessera_bridge.darwin-universal.node`).
    addon=$(find "$app_path" -type f -name '*.node' | head -n1 || true)
  fi
  if [[ -z "$addon" ]]; then
    echo "ERROR: no .node addon found inside $app_path — bridge would fail to load" >&2
    hdiutil detach "$mount_dir" -quiet -force 2>/dev/null || true
    exit 6
  fi
  echo "    addon: $addon"

  # `lipo -info` prints one of:
  #   Non-fat file: <path> is architecture: x86_64
  #   Non-fat file: <path> is architecture: arm64
  #   Architectures in the fat file: <path> are: x86_64 arm64
  lipo_info=$(lipo -info "$addon" 2>&1)
  echo "    lipo:  $lipo_info"

  # Decide which slice composition this DMG should carry. We treat anything
  # ending in `-x64.dmg` as the x64 build, `-arm64.dmg` as arm64, and
  # `-universal.dmg` as both.
  base=$(basename "$dmg")
  case "$base" in
    *-x64.dmg)
      saw_x64=1
      if ! grep -qE 'architecture: x86_64\b|x86_64 arm64|arm64 x86_64' <<<"$lipo_info"; then
        echo "ERROR: x64 DMG addon does not contain an x86_64 slice (lipo: $lipo_info)" >&2
        hdiutil detach "$mount_dir" -quiet -force 2>/dev/null || true
        exit 7
      fi
      echo "    [OK ] x86_64 slice present"
      ;;
    *-arm64.dmg)
      saw_arm64=1
      if ! grep -qE 'architecture: arm64\b|x86_64 arm64|arm64 x86_64' <<<"$lipo_info"; then
        echo "ERROR: arm64 DMG addon does not contain an arm64 slice (lipo: $lipo_info)" >&2
        hdiutil detach "$mount_dir" -quiet -force 2>/dev/null || true
        exit 8
      fi
      echo "    [OK ] arm64 slice present"
      ;;
    *-universal.dmg)
      saw_universal=1
      saw_x64=1
      saw_arm64=1
      if ! grep -qE 'x86_64 arm64|arm64 x86_64' <<<"$lipo_info"; then
        echo "ERROR: universal DMG addon does not contain both x86_64 AND arm64 slices (lipo: $lipo_info)" >&2
        hdiutil detach "$mount_dir" -quiet -force 2>/dev/null || true
        exit 9
      fi
      echo "    [OK ] x86_64 + arm64 slices both present"
      ;;
    *)
      echo "WARN: unrecognised DMG naming pattern: $base — skipping arch assertion"
      ;;
  esac

  hdiutil detach "$mount_dir" -quiet -force 2>/dev/null || true
  rm -rf "$mount_dir"
done

# Final coverage check: either a universal DMG or BOTH single-arch DMGs.
if [[ $saw_universal -eq 0 ]]; then
  if [[ $saw_x64 -eq 0 ]]; then
    echo "ERROR: no x64 DMG produced (and no universal DMG either)" >&2
    exit 10
  fi
  if [[ $saw_arm64 -eq 0 ]]; then
    echo "ERROR: no arm64 DMG produced (and no universal DMG either)" >&2
    exit 11
  fi
fi

echo ""
echo "==> macOS package verification PASSED"
