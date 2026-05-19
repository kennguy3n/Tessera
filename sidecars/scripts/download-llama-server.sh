#!/usr/bin/env bash
set -euo pipefail

# Download the correct llama-server binary for the current platform.
# Places binary at sidecars/llama-server/llama-server (or .exe on Windows).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SIDECAR_DIR="$SCRIPT_DIR/../llama-server"
VERSION="${LLAMA_CPP_VERSION:-b4546}"

mkdir -p "$SIDECAR_DIR"

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
    Linux)
        case "$ARCH" in
            x86_64)  PLATFORM="linux-x64" ;;
            aarch64) PLATFORM="linux-arm64" ;;
            *)       echo "Unsupported arch: $ARCH"; exit 1 ;;
        esac
        BINARY_NAME="llama-server"
        ;;
    Darwin)
        case "$ARCH" in
            x86_64)  PLATFORM="macos-x64" ;;
            arm64)   PLATFORM="macos-arm64" ;;
            *)       echo "Unsupported arch: $ARCH"; exit 1 ;;
        esac
        BINARY_NAME="llama-server"
        ;;
    *)
        echo "Unsupported OS: $OS — use download-llama-server.ps1 on Windows"
        exit 1
        ;;
esac

BASE_URL="https://github.com/ggerganov/llama.cpp/releases/download/${VERSION}"
ARCHIVE_NAME="llama-${VERSION}-bin-${PLATFORM}.zip"
DOWNLOAD_URL="${BASE_URL}/${ARCHIVE_NAME}"

echo "Downloading llama.cpp ${VERSION} for ${PLATFORM}..."
echo "  URL: ${DOWNLOAD_URL}"

TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

curl -fSL --progress-bar "$DOWNLOAD_URL" -o "$TEMP_DIR/$ARCHIVE_NAME"
unzip -q "$TEMP_DIR/$ARCHIVE_NAME" -d "$TEMP_DIR/extracted"

# Find the llama-server binary in the extracted archive
FOUND_BINARY="$(find "$TEMP_DIR/extracted" -name "$BINARY_NAME" -type f | head -1)"

if [ -z "$FOUND_BINARY" ]; then
    echo "ERROR: Could not find $BINARY_NAME in archive"
    echo "Archive contents:"
    find "$TEMP_DIR/extracted" -type f
    exit 1
fi

cp "$FOUND_BINARY" "$SIDECAR_DIR/$BINARY_NAME"
chmod +x "$SIDECAR_DIR/$BINARY_NAME"

echo "Installed: $SIDECAR_DIR/$BINARY_NAME"
"$SIDECAR_DIR/$BINARY_NAME" --version 2>/dev/null || true
echo "Done."
