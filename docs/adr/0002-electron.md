# 2. Electron + React for the desktop shell

## Status

Accepted.

## Context

Tessera is a desktop application that must run on macOS, Windows, and
Linux with a single UI codebase and a rich, modern interface (a command
palette, multiple artifact editors, live model/runtime status, settings,
connector management). It also needs deep OS integration — native file
dialogs, an OS keychain, deep-link protocol handlers, auto-update, and
the ability to supervise local model sidecar processes — none of which a
sandboxed web app can do.

## Decision

Use Electron for the desktop shell with a strict process split, and
React + TypeScript for the renderer UI (`apps/desktop`):

- `apps/desktop/electron` — the Electron **main** process: window
  management, CSP installation, IPC handler registration, connector
  sync, the model runtime supervisor, and the N-API bridge to the Rust
  core. Entry point `electron/main.ts`.
- `apps/desktop/renderer` — the React UI (`renderer/src`), built with
  Vite, routed with `react-router-dom`, and using TipTap for rich-text
  editing.
- `apps/desktop/shared` — wire types shared by both sides
  (`shared/types.ts`), so there is one definition per IPC payload.

The renderer is treated as untrusted: it has no direct file, token, DB,
or model-process access and talks to the main process only through a
typed, validated IPC surface (`window.tessera`, defined by `TesseraApi`
in `shared/types.ts` and bridged in `electron/preload.ts`). See
[ADR-0010](0010-csp-nonce.md) for the renderer CSP.

## Consequences

- One UI codebase ships to three platforms, and the renderer can use the
  mature React/TypeScript ecosystem.
- The hard main/renderer boundary is a security feature: the documented
  anti-patterns (renderer touching files, tokens, the encrypted DB, or
  model processes) are structurally impossible because those
  capabilities live only in the main process.
- Electron carries a Chromium-sized binary and memory footprint, and
  every new capability the renderer needs must be added as an explicit,
  validated IPC channel rather than called directly.
- The split requires keeping `TesseraApi`, `preload.ts`, and the main
  process handlers in sync; the contract is enforced by TypeScript types
  and tests under `electron/__tests__/`.
