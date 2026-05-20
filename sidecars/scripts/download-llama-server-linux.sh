#!/usr/bin/env bash
# Linux-specific llama-server downloader.
# Picks the appropriate llama.cpp build for x86_64 Linux (with AVX2/AVX-512 support
# in upstream releases) and falls back gracefully when the matching asset is missing.
# Verifies sha256 from sidecars/models.json when a real checksum is published.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SIDECAR_ROOT="$SCRIPT_DIR/.."
SIDECAR_DIR="$SIDECAR_ROOT/llama-server"
MODELS_JSON="$SIDECAR_ROOT/models.json"
VERSION="${LLAMA_CPP_VERSION:-b4546}"

mkdir -p "$SIDECAR_DIR"

if [ "$(uname -s)" != "Linux" ]; then
    echo "ERROR: This script is for Linux only. Use download-llama-server.sh for macOS or .ps1 on Windows."
    exit 1
fi

ARCH="$(uname -m)"
case "$ARCH" in
    x86_64)  PLATFORM="linux-x64" ;;
    aarch64) PLATFORM="linux-arm64" ;;
    *)       echo "ERROR: Unsupported Linux architecture: $ARCH"; exit 1 ;;
esac

BINARY_NAME="llama-server"
TARGET_BINARY="$SIDECAR_DIR/$BINARY_NAME"

if [ -x "$TARGET_BINARY" ]; then
    echo "llama-server already installed at $TARGET_BINARY"
    "$TARGET_BINARY" --version 2>/dev/null || true
    echo "To force re-download, remove $TARGET_BINARY and re-run."
    exit 0
fi

BASE_URL="https://github.com/ggerganov/llama.cpp/releases/download/${VERSION}"
ARCHIVE_NAME="llama-${VERSION}-bin-${PLATFORM}.zip"
DOWNLOAD_URL="${BASE_URL}/${ARCHIVE_NAME}"

echo "Downloading llama.cpp ${VERSION} for ${PLATFORM}..."
echo "  URL: ${DOWNLOAD_URL}"

TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

curl -fSL --retry 3 --retry-delay 5 --progress-bar "$DOWNLOAD_URL" -o "$TEMP_DIR/$ARCHIVE_NAME"

# Verify checksum from models.json if present
if [ -f "$MODELS_JSON" ] && command -v python3 >/dev/null 2>&1; then
    EXPECTED_HASH=$(python3 -c "
import json, sys
with open('$MODELS_JSON') as f:
    data = json.load(f)
server_checksum = data.get('server_checksums', {}).get('$PLATFORM', '')
if server_checksum.startswith('sha256:'):
    print(server_checksum.split(':', 1)[1])
" 2>/dev/null || true)

    if [ -n "$EXPECTED_HASH" ] && [ "$EXPECTED_HASH" != "placeholder-update-with-real-hash-after-model-publish" ]; then
        echo "Verifying checksum..."
        ACTUAL_HASH="$(sha256sum "$TEMP_DIR/$ARCHIVE_NAME" | awk '{print $1}')"
        if [ "$ACTUAL_HASH" != "$EXPECTED_HASH" ]; then
            echo "ERROR: Checksum mismatch."
            echo "  Expected: $EXPECTED_HASH"
            echo "  Actual:   $ACTUAL_HASH"
            exit 1
        fi
        echo "Checksum verified."
    else
        echo "No published server checksum for $PLATFORM — skipping verification."
    fi
fi

unzip -q "$TEMP_DIR/$ARCHIVE_NAME" -d "$TEMP_DIR/extracted"

FOUND_BINARY="$(find "$TEMP_DIR/extracted" -name "$BINARY_NAME" -type f | head -1)"
if [ -z "$FOUND_BINARY" ]; then
    echo "ERROR: Could not find $BINARY_NAME in archive"
    echo "Archive contents:"
    find "$TEMP_DIR/extracted" -type f
    exit 1
fi

# Some Linux releases ship llama-server alongside required shared libs (libllama.so).
# Copy them all into SIDECAR_DIR so the binary can load them via $ORIGIN at runtime.
EXTRACT_DIR="$(dirname "$FOUND_BINARY")"
cp "$FOUND_BINARY" "$TARGET_BINARY"
chmod +x "$TARGET_BINARY"
find "$EXTRACT_DIR" -maxdepth 1 -type f \( -name '*.so' -o -name '*.so.*' \) -exec cp -f {} "$SIDECAR_DIR/" \; 2>/dev/null || true

echo "Installed: $TARGET_BINARY"
"$TARGET_BINARY" --version 2>/dev/null || true
echo "Done."
