# Tessera Sidecars

This directory contains model inference sidecar binaries and download scripts for the Tessera local AI runtime.

## Directory Structure

```
sidecars/
├── models.json                     # Model manifest (URLs, checksums, sizes)
├── scripts/
│   ├── download-llama-server.sh    # macOS/Linux download script
│   └── download-llama-server.ps1   # Windows download script
├── llama-server/                   # Downloaded binary (gitignored)
│   └── llama-server(.exe)
└── README.md
```

## Quick Start

### macOS / Linux

```bash
./sidecars/scripts/download-llama-server.sh
```

### Windows (PowerShell)

```powershell
.\sidecars\scripts\download-llama-server.ps1
```

## How It Works

1. The script detects the current platform (OS + architecture).
2. Downloads the matching pre-built `llama-server` binary from the [llama.cpp releases](https://github.com/ggerganov/llama.cpp/releases).
3. Verifies the SHA-256 checksum against `models.json` (if a checksum is recorded).
4. Extracts and installs the binary to `sidecars/llama-server/`.
5. Skips download if the binary already exists.

## Model Manifest (`models.json`)

The manifest lists supported models with metadata:

| Field              | Description                          |
| ------------------ | ------------------------------------ |
| `id`               | Unique model identifier              |
| `name`             | Human-readable name                  |
| `parameters`       | Model parameter count                |
| `quantization`     | GGUF quantization level              |
| `required_ram_gb`  | Minimum RAM for inference            |
| `download_size_mb` | Download size in megabytes           |
| `context_length`   | Maximum context window               |
| `tier`             | Device tier: `low`, `medium`, `high` |
| `url`              | Model GGUF download URL              |
| `checksum`         | SHA-256 checksum (`sha256:<hash>`)   |

## Environment Variables

| Variable            | Default | Description                        |
| ------------------- | ------- | ---------------------------------- |
| `LLAMA_CPP_VERSION` | `b4546` | llama.cpp release version to fetch |

## Packaging

When building the Tessera desktop app, the `llama-server` binary is included as an `extraResource` via electron-builder. The download scripts are development tools only — release builds bundle the pre-downloaded binary.
