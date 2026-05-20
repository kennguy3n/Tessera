#!/usr/bin/env bash
set -euo pipefail

# Download the correct llama-server binary for the current platform and compute
# backend. The PrismML llama.cpp fork ships separate archives per (platform,
# backend) combination — pick the one that matches the local hardware so the
# runtime ggml dispatcher has the kernel it needs.
#
# Usage:
#   ./download-llama-server.sh [--compute cpu|cuda|vulkan|rocm] [--version <tag>]
#
# Notes:
#   - macOS Apple Silicon: the MLX adapter is the primary path; llama-server is
#     the CPU fallback. We never download a CUDA or Vulkan build for macOS arm64.
#   - On all other platforms we default to `cpu`. The CPU build is compiled
#     against AVX2 minimum and the dispatcher auto-promotes to AVX-VNNI / AVX-512
#     VNNI at runtime when supported, so the CPU archive is correct for every
#     CPU-only machine without further selection.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SIDECAR_ROOT="$SCRIPT_DIR/.."
SIDECAR_DIR="$SIDECAR_ROOT/llama-server"
MODELS_JSON="$SIDECAR_ROOT/models.json"
VERSION="${LLAMA_CPP_VERSION:-b4546}"
COMPUTE="${LLAMA_CPP_COMPUTE:-cpu}"

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
Usage: $0 [--compute cpu|cuda|vulkan|rocm] [--version <release-tag>]

  --compute   Compute backend variant. Defaults to "cpu" (or "metal" on macOS
              arm64, which uses the same CPU archive as a fallback for the MLX
              adapter). NVIDIA -> cuda, AMD on Linux -> rocm, cross-platform GPU
              -> vulkan.
  --version   PrismML llama.cpp release tag. Defaults to "${VERSION}".
USAGE
            exit 0
            ;;
        *)
            echo "ERROR: Unknown argument: $1" >&2
            exit 2
            ;;
    esac
done

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
            x86_64)  PLATFORM="macos-intel" ;;
            arm64)
                PLATFORM="macos-apple-silicon"
                # On Apple Silicon, Tessera uses MLX as the primary path. The
                # llama-server binary is the CPU fallback; the upstream archive
                # ships a single arm64 build (no separate CUDA/Vulkan variants
                # on macOS), so we always select the CPU variant here.
                if [[ "$COMPUTE" != "cpu" ]]; then
                    echo "INFO: macOS arm64 only ships a CPU llama-server variant; forcing --compute=cpu (MLX is the primary GPU path)."
                    COMPUTE="cpu"
                fi
                ;;
            *)       echo "ERROR: Unsupported architecture: $ARCH"; exit 1 ;;
        esac
        BINARY_NAME="llama-server"
        CHECKSUM_CMD="shasum -a 256"
        ;;
    *)
        echo "ERROR: Unsupported OS: $OS - use download-llama-server.ps1 on Windows"
        exit 1
        ;;
esac

case "$COMPUTE" in
    cpu|cuda|vulkan|rocm) ;;
    *)
        echo "ERROR: Invalid --compute value: $COMPUTE (expected: cpu, cuda, vulkan, rocm)" >&2
        exit 2
        ;;
esac

# ROCm is only supported on Linux x86_64; reject the combination elsewhere.
if [[ "$COMPUTE" == "rocm" && "$PLATFORM" != "linux-x64" ]]; then
    echo "ERROR: --compute=rocm is only supported on linux-x64 (saw platform=$PLATFORM)" >&2
    exit 2
fi

VARIANT_KEY="${PLATFORM}-${COMPUTE}"
TARGET_BINARY="$SIDECAR_DIR/$BINARY_NAME"
INSTALL_TAG="$SIDECAR_DIR/.installed-variant"

# Reuse cached binary only if it matches the requested variant.
if [[ -x "$TARGET_BINARY" ]]; then
    if [[ -f "$INSTALL_TAG" && "$(cat "$INSTALL_TAG")" == "$VARIANT_KEY" ]]; then
        echo "llama-server (${VARIANT_KEY}) already installed at $TARGET_BINARY"
        "$TARGET_BINARY" --version 2>/dev/null || true
        echo "To force re-download, remove $TARGET_BINARY and re-run."
        exit 0
    fi
    echo "Replacing existing llama-server binary (was: $(cat "$INSTALL_TAG" 2>/dev/null || echo unknown), now: $VARIANT_KEY)"
fi

# Resolve URL + checksum from the manifest when available. The manifest lists
# llama_server.variants[] with {platform, compute, url, sha256}.
RESOLVED_URL=""
EXPECTED_HASH=""
if [[ -f "$MODELS_JSON" ]] && command -v python3 &>/dev/null; then
    # IMPORTANT: emit URL + SHA on a single space-separated line so that
    # `read -r RESOLVED_URL EXPECTED_HASH` can split them into both variables.
    # `read` only consumes one line from stdin, so multi-line output would
    # leave EXPECTED_HASH empty and silently skip checksum verification.
    #
    # ASSUMPTION (Devin Review finding 3270889887): space-as-delimiter is
    # safe because llama_server.variants[].url is always an HTTP(S) URL
    # (RFC 3986 forbids literal spaces in the path/query; they'd be
    # %20-encoded) and the SHA is hex characters. If a future manifest
    # adds a file:// URL with spaces, switch to a tab delimiter:
    #   print(f"{url}\t{sha}")  +  IFS=$'\t' read -r RESOLVED_URL EXPECTED_HASH
    # That's a 2-line change localised to this heredoc.
    #
    # The manifest path, platform key, and compute key are passed to Python
    # via argv (sys.argv[1..3]) instead of being interpolated into the
    # heredoc body. Direct shell interpolation inside `python3 - <<PY` is
    # fragile: a path containing `"`, `\`, or even a stray newline would
    # produce syntactically-invalid Python and silently break manifest
    # resolution. Passing via argv keeps the Python source static and
    # treats every input as data, not code.
    read -r RESOLVED_URL EXPECTED_HASH <<EOF
$(python3 - "$MODELS_JSON" "$PLATFORM" "$COMPUTE" <<'PY'
import json
import sys

manifest_path, platform, compute = sys.argv[1], sys.argv[2], sys.argv[3]
with open(manifest_path) as f:
    data = json.load(f)
url = ""
sha = ""
for v in data.get("llama_server", {}).get("variants", []):
    if v.get("platform") == platform and v.get("compute") == compute:
        url = v.get("url") or ""
        sha = v.get("sha256") or ""
        break
print(f"{url} {sha}")
PY
)
EOF
fi

if [[ -z "$RESOLVED_URL" || "$RESOLVED_URL" == "placeholder" ]]; then
    # No usable URL in the manifest for this (platform, compute) variant.
    # Previously we constructed a fallback URL against ggerganov/llama.cpp
    # using PrismML platform names (linux-x64, macos-apple-silicon, ...), but
    # ggerganov's release assets use a different naming convention so the
    # fallback would 404 in practice — silently misleading anyone who cleared
    # the manifest during development. Fail loudly instead with a clear
    # pointer to the manifest entry that needs to be populated.
    #
    # (Devin Review finding 3270628605.)
    cat >&2 <<EOF
ERROR: No URL configured in $MODELS_JSON for variant: $VARIANT_KEY
       Populate llama_server.variants[].url for platform=$PLATFORM, compute=$COMPUTE
       with a real PrismML llama.cpp release asset before running this script.
EOF
    exit 1
fi

echo "Downloading llama.cpp ${VERSION} for ${VARIANT_KEY}..."
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

# Extract based on archive format. The manifest currently ships PrismML
# llama.cpp release assets as `.tar.gz` for Linux/macOS and `.zip` for
# Windows; rather than hard-coding one format, dispatch on the actual
# filename so the script keeps working if the upstream packaging
# convention changes for a future variant. (Devin Review BUG finding
# 3270826050: the previous unconditional `unzip` failed on every
# `.tar.gz` variant.)
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
"$TARGET_BINARY" --version 2>/dev/null || true
echo "Done."
