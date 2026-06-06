# 5. KChat (Mattermost v4) as the collaboration layer

## Status

Accepted.

## Context

A local-first app ([ADR-0004](0004-local-first.md)) still needs a team
collaboration surface: a way to pull team conversations and files in as
retrievable evidence, and a way to push finished artifacts back out to
the team. Building a bespoke real-time backend would contradict the
local-first, no-server-to-operate stance. Many teams already run a
Mattermost-compatible chat server.

## Decision

Integrate with **KChat**, a [Mattermost v4](https://api.mattermost.com/)-compatible
chat server, as a first-class collaboration layer
(`apps/desktop/electron/kchat`). KChat is used both as a **source**
(channels, posts, and files are indexed into the substrate) and as a
**destination** (artifacts can be shared into a channel, optionally with
an evidence pack).

Key design points:

- **Single PAT auth path.** A user pastes a personal access token (and
  optionally a server URL) into Settings. The token is verified against
  `/users/me` before persistence and stored in the vault under provider
  `kchat`. There is no session handoff with KChat Desktop — the two are
  independent clients of the same backend (`kchat/kchatAuth.ts`,
  `kchat/kchatClient.ts`).
- **Loopback bridge, not shared IPC.** A `.kcz` extension running inside
  KChat Desktop (`extensions/tessera-kchat/`) talks to Tessera over a
  loopback-only HTTP API. `KchatLocalApiServer` binds `127.0.0.1` on a
  kernel-assigned port and writes the port + bearer token to
  `{userData}/tessera-kchat-port.json` (mode 0600). Every request must
  prove the bearer token and assert a `127.0.0.1` `Host` header to block
  DNS-rebind SSRF (`kchat/ssrfGuard.ts`).
- **Deep links** (`tessera://`, `kchat://`) handle cross-app navigation
  (`kchat/kchatDeeplinkBridge.ts`).
- Indexed KChat content is encrypted and access-controlled like any
  other source, with revocation support
  (`crates/tessera_sources/src/kchat_crypto.rs`).

## Consequences

- Teams get collaboration without Tessera running its own server: it
  rides on an existing Mattermost-compatible deployment.
- The cross-app surface is deliberately three narrow, independently
  authenticated channels (extension, loopback API, deep links) with no
  shared token or session, which limits blast radius but adds moving
  parts and SSRF/security tests to maintain.
- Tessera tracks the Mattermost v4 API contract; server-side
  incompatibilities surface as connector errors.
- KChat ingestion must respect the same encryption, ACL, and revocation
  guarantees as local sources, adding the `kchat_crypto` layer and ACL
  bookkeeping.
