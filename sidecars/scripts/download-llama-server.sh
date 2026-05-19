#!/usr/bin/env bash
set -euo pipefail

# Download the correct llama-server binary for the current platform.
# Places binary at sidecars/llama-server/llama-server (or .exe on Windows).
# Reads model manifest from sidecars/models.json for checksums.
# Skips download if valid binary already exists.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SIDECAR_ROOT="$SCRIPT_DIR/.."
SIDECAR_DIR="$SIDECAR_ROOT/llama-server"
MODELS_JSON="$SIDECAR_ROOT/models.json"
VERSION="${LLAMA_CPP_VERSION:-b4546}"

mkdir -p "$SIDECAR_DIR"

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
    Linux)
        case "$ARCH" in
            x86_64)  PLATFORM="linux-x64" ;;
            aarch64) PLATFORM="linux-arm64" ;;
            *)       echo "ERROR: Unsupported architecture: $ARCH"; exit 1 ;;
        esac
        BINARY_NAME="llama-server"
        CHECKSUM_CMD="sha256sum"
        ;;
    Darwin)
        case "$ARCH" in
            x86_64)  PLATFORM="macos-x64" ;;
            arm64)   PLATFORM="macos-arm64" ;;
            *)       echo "ERROR: Unsupported architecture: $ARCH"; exit 1 ;;
        esac
        BINARY_NAME="llama-server"
        CHECKSUM_CMD="shasum -a 256"
        ;;
    *)
        echo "ERROR: Unsupported OS: $OS — use download-llama-server.ps1 on Windows"
        exit 1
        ;;
esac

TARGET_BINARY="$SIDECAR_DIR/$BINARY_NAME"

# Check if binary already exists and is executable
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

# Verify checksum if available in models.json
if [ -f "$MODELS_JSON" ]; then
    # Extract expected checksum from models.json (format: "sha256:<hash>")
    EXPECTED_HASH=""
    if command -v python3 &>/dev/null; then
        EXPECTED_HASH=$(python3 -c "
import json, sys
with open('$MODELS_JSON') as f:
    data = json.load(f)
server_checksum = data.get('server_checksums', {}).get('$PLATFORM', '')
if server_checksum.startswith('sha256:'):
    print(server_checksum.split(':')[1])
" 2>/dev/null || true)
    fi

    if [ -n "$EXPECTED_HASH" ] && [ "$EXPECTED_HASH" != "placeholder-update-with-real-hash-after-model-publish" ]; then
        echo "Verifying checksum..."
        ACTUAL_HASH=$($CHECKSUM_CMD "$TEMP_DIR/$ARCHIVE_NAME" | awk '{print $1}')
        if [ "$ACTUAL_HASH" != "$EXPECTED_HASH" ]; then
            echo "ERROR: Checksum mismatch!"
            echo "  Expected: $EXPECTED_HASH"
            echo "  Actual:   $ACTUAL_HASH"
            exit 1
        fi
        echo "Checksum verified."
    else
        echo "No server checksum in manifest — skipping verification."
    fi
fi

unzip -q "$TEMP_DIR/$ARCHIVE_NAME" -d "$TEMP_DIR/extracted"

# Find the llama-server binary in the extracted archive
FOUND_BINARY="$(find "$TEMP_DIR/extracted" -name "$BINARY_NAME" -type f | head -1)"

if [ -z "$FOUND_BINARY" ]; then
    echo "ERROR: Could not find $BINARY_NAME in archive"
    echo "Archive contents:"
    find "$TEMP_DIR/extracted" -type f
    exit 1
fi

cp "$FOUND_BINARY" "$TARGET_BINARY"
chmod +x "$TARGET_BINARY"

echo "Installed: $TARGET_BINARY"
"$TARGET_BINARY" --version 2>/dev/null || true
echo "Done."
