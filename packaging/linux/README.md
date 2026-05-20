# Linux packaging notes

Tessera ships on Linux as three distribution formats:

| Format    | Target arch | Notes                                                                  |
|-----------|-------------|------------------------------------------------------------------------|
| AppImage  | x86_64      | Self-contained, sandbox-friendly; no install required                  |
| .deb      | x86_64      | Debian / Ubuntu / Pop!\_OS / Mint                                      |
| .rpm      | x86_64      | Fedora / RHEL / openSUSE                                               |

## Runtime requirements

- glibc 2.31+ (Ubuntu 20.04 / Debian 11 baseline)
- libsecret-1-0 (token vault — Electron `safeStorage` uses libsecret via GNOME Keyring / KWallet)
- libgtk-3-0, libnss3, libatk1.0-0, libdrm2, libxkbfile1, libgbm1 (standard Electron deps)
- A working CPU sidecar requires AVX2 (Haswell+); AVX-512 / VNNI are detected and used when present
- Optional: a Vulkan-capable GPU + `libvulkan1` for accelerated inference

## Building

```bash
# from repo root, after `npm install` and `npm run build:native`
npx electron-builder --linux --config packaging/electron-builder.yml
```

The `linux:` section of `packaging/electron-builder.yml` enumerates the three
targets above and points at `build/icons/` (PNG icon set) and
`packaging/linux/tessera.desktop` for the menu entry.

## Sidecar binary

The CPU/Vulkan llama-server binary is downloaded by
`sidecars/scripts/download-llama-server.sh` at install time (which delegates to
`download-llama-server-linux.sh` on Linux) and bundled via the
`extraResources` block of the electron-builder config.
