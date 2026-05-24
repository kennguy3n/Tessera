#!/usr/bin/env bash
set -euo pipefail

# Download the correct sd-server binary (stable-diffusion.cpp's HTTP
# server) for the current platform and GPU backend. This script
# mirrors download-llama-server.sh but resolves URLs from the
# `diffusion_server` block of sidecars/models.json instead of
# `llama_server`.
#
# Image generation is GPU-only: there is no "cpu" variant of
# sd-server in the manifest because diffusion on CPU is too slow
# to be usable (a single FLUX.2-klein image takes >5 min even on
# fast CPUs vs. ~15 s on a consumer GPU). The manifest deliberately
# omits the cpu backend; this script enforces the same invariant.
#
# Usage:
#   ./download-sd-server.sh [--compute cuda|vulkan|rocm|metal] [--version <tag>]
# Prerequisites:
#   - bash, curl, mkdir, tar, mktemp, python3, sha256sum/shasum
#   - the (platform, compute) variant must exist in models.json

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SIDECAR_ROOT="$SCRIPT_DIR/.."
SIDECAR_DIR="$SIDECAR_ROOT/sd-server"
MODELS_JSON="$SIDECAR_ROOT/models.json"
VERSION="${SD_SERVER_VERSION:-master-c2f6c81}"
# No safe cross-platform default: NVIDIA = cuda, AMD/Linux = rocm,
# cross-vendor GPU = vulkan, Apple Silicon = metal. Force the
# caller to choose so we don't silently install the wrong kernel.
COMPUTE="${SD_SERVER_COMPUTE:-}"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --compute)
            COMPUTE="$2"
            shift 2
            ;;
        --version)
            VERSION="$2"
            shift 2
            ;;
        --help|-h)
            cat <<USAGE
Usage: $0 [--compute cuda|vulkan|rocm|metal] [--version <release-tag>]

  --compute   Required. GPU backend variant. Diffusion is GPU-only:
              NVIDIA -> cuda, AMD on Linux -> rocm, cross-vendor GPU
              -> vulkan, Apple Silicon -> metal. There is no cpu
              variant.
  --version   stable-diffusion.cpp release tag. Defaults to "${VERSION}".

Requires: python3 on PATH. Install via the distro package manager
(apt install python3 / brew install python3 / pacman -S python).
USAGE
            exit 0
            ;;
        *)
            echo "ERROR: Unknown argument: $1" >&2
            exit 2
            ;;
    esac
done

if [[ -z "$COMPUTE" ]]; then
    echo "ERROR: --compute is required (cuda|vulkan|rocm|metal). Diffusion is GPU-only — there is no cpu variant." >&2
    exit 2
fi

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
        BINARY_NAME="sd-server"
        CHECKSUM_CMD="sha256sum"
        ;;
    Darwin)
        case "$ARCH" in
            arm64)
                PLATFORM="macos-apple-silicon"
                # Apple Silicon's only valid backend is metal — the
                # other variants exist for Linux / Windows only.
                if [[ "$COMPUTE" != "metal" ]]; then
                    echo "ERROR: macOS Apple Silicon only supports --compute=metal (saw: $COMPUTE)" >&2
                    exit 2
                fi
                ;;
            x86_64)
                # leejet's stable-diffusion.cpp release matrix does
                # not currently ship Intel macOS builds; FLUX is too
                # heavy for Intel iGPUs in practice. Fail clearly
                # rather than chasing a 404.
                echo "ERROR: macOS Intel is not supported for diffusion. Use a Linux box with a discrete GPU." >&2
                exit 1
                ;;
            *)
                echo "ERROR: Unsupported architecture: $ARCH"; exit 1 ;;
        esac
        BINARY_NAME="sd-server"
        CHECKSUM_CMD="shasum -a 256"
        ;;
    *)
        echo "ERROR: Unsupported OS: $OS - use download-sd-server.ps1 on Windows" >&2
        exit 1
        ;;
esac

case "$COMPUTE" in
    cuda|vulkan|rocm|metal) ;;
    cpu)
        echo "ERROR: --compute=cpu is not supported for diffusion. The diffusion sidecar is GPU-only by design (CPU diffusion is too slow to be usable)." >&2
        exit 2
        ;;
    *)
        echo "ERROR: Invalid --compute value: $COMPUTE (expected: cuda, vulkan, rocm, metal)" >&2
        exit 2
        ;;
esac

# ROCm: Linux x86_64 only.
if [[ "$COMPUTE" == "rocm" && "$PLATFORM" != "linux-x64" ]]; then
    echo "ERROR: --compute=rocm is only supported on linux-x64 (saw platform=$PLATFORM)" >&2
    exit 2
fi
# Metal: macOS Apple Silicon only.
if [[ "$COMPUTE" == "metal" && "$PLATFORM" != "macos-apple-silicon" ]]; then
    echo "ERROR: --compute=metal is only supported on macos-apple-silicon (saw platform=$PLATFORM)" >&2
    exit 2
fi

VARIANT_KEY="${PLATFORM}-${COMPUTE}"
TARGET_BINARY="$SIDECAR_DIR/$BINARY_NAME"
INSTALL_TAG="$SIDECAR_DIR/.installed-variant"

if [[ -x "$TARGET_BINARY" ]]; then
    if [[ -f "$INSTALL_TAG" && "$(cat "$INSTALL_TAG")" == "$VARIANT_KEY" ]]; then
        echo "sd-server (${VARIANT_KEY}) already installed at $TARGET_BINARY"
        "$TARGET_BINARY" --help 2>/dev/null | head -1 || true
        echo "To force re-download, remove $TARGET_BINARY and re-run."
        exit 0
    fi
    echo "Replacing existing sd-server binary (was: $(cat "$INSTALL_TAG" 2>/dev/null || echo unknown), now: $VARIANT_KEY)"
fi

if [[ ! -f "$MODELS_JSON" ]]; then
    echo "ERROR: Missing manifest at $MODELS_JSON" >&2
    echo "       Run from the repo root, or set MODELS_JSON to an alternate path." >&2
    exit 1
fi
if ! command -v python3 &>/dev/null; then
    cat >&2 <<EOF
ERROR: python3 not found on PATH.
       This script uses python3 to resolve the download URL and SHA256 for
       the requested (platform=$PLATFORM, compute=$COMPUTE) variant from
       $MODELS_JSON. Install python3 via your distro's package manager:
           Debian/Ubuntu:  apt install python3
           Fedora/RHEL:    dnf install python3
           macOS (brew):   brew install python3
           Arch:           pacman -S python
       Then re-run this script.
EOF
    exit 1
fi

# Identical resolution pattern as download-llama-server.sh: pass the
# manifest path + platform + compute through argv to keep the
# heredoc body static, then split URL + SHA on whitespace. The same
# RFC 3986 invariant (no literal spaces in HTTP URLs) holds here.
RESOLVED_URL=""
EXPECTED_HASH=""
read -r RESOLVED_URL EXPECTED_HASH <<EOF
$(python3 - "$MODELS_JSON" "$PLATFORM" "$COMPUTE" <<'PY'
import json
import sys

manifest_path, platform, compute = sys.argv[1], sys.argv[2], sys.argv[3]
with open(manifest_path) as f:
    data = json.load(f)
url = ""
sha = ""
for v in data.get("diffusion_server", {}).get("variants", []):
    if v.get("platform") == platform and v.get("compute") == compute:
        url = v.get("url") or ""
        sha = v.get("sha256") or ""
        break
print(f"{url} {sha}")
PY
)
EOF

if [[ -z "$RESOLVED_URL" || "$RESOLVED_URL" == "placeholder" ]]; then
    cat >&2 <<EOF
ERROR: No URL configured in $MODELS_JSON for variant: $VARIANT_KEY
       Populate diffusion_server.variants[].url for platform=$PLATFORM,
       compute=$COMPUTE with a real stable-diffusion.cpp release asset
       before running this script.
EOF
    exit 1
fi

echo "Downloading stable-diffusion.cpp ${VERSION} for ${VARIANT_KEY}..."
echo "  URL: ${RESOLVED_URL}"

TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

ARCHIVE_PATH="$TEMP_DIR/$(basename "$RESOLVED_URL")"
curl -fSL --retry 3 --retry-delay 5 --progress-bar "$RESOLVED_URL" -o "$ARCHIVE_PATH"

if [[ -n "$EXPECTED_HASH" && "$EXPECTED_HASH" != "placeholder" ]]; then
    echo "Verifying checksum..."
    ACTUAL_HASH=$($CHECKSUM_CMD "$ARCHIVE_PATH" | awk '{print $1}')
    if [[ "$ACTUAL_HASH" != "$EXPECTED_HASH" ]]; then
        echo "ERROR: Checksum mismatch!" >&2
        echo "  Expected: $EXPECTED_HASH" >&2
        echo "  Actual:   $ACTUAL_HASH" >&2
        exit 1
    fi
    echo "Checksum verified."
else
    echo "No checksum in manifest for $VARIANT_KEY - skipping verification."
fi

mkdir -p "$TEMP_DIR/extracted"
case "$ARCHIVE_PATH" in
    *.tar.gz|*.tgz)
        tar -xzf "$ARCHIVE_PATH" -C "$TEMP_DIR/extracted"
        ;;
    *.zip)
        unzip -q "$ARCHIVE_PATH" -d "$TEMP_DIR/extracted"
        ;;
    *)
        echo "ERROR: Unknown archive format for $ARCHIVE_PATH" >&2
        echo "       Expected .tar.gz / .tgz / .zip" >&2
        exit 1
        ;;
esac

FOUND_BINARY="$(find "$TEMP_DIR/extracted" -name "$BINARY_NAME" -type f | head -1)"
if [[ -z "$FOUND_BINARY" ]]; then
    echo "ERROR: Could not find $BINARY_NAME in archive" >&2
    echo "Archive contents:" >&2
    find "$TEMP_DIR/extracted" -type f >&2
    exit 1
fi

cp "$FOUND_BINARY" "$TARGET_BINARY"
chmod +x "$TARGET_BINARY"
echo "$VARIANT_KEY" >"$INSTALL_TAG"

echo "Installed: $TARGET_BINARY (variant: $VARIANT_KEY)"
"$TARGET_BINARY" --help 2>/dev/null | head -1 || true
echo "Done."
