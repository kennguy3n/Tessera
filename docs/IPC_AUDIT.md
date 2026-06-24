# IPC channel audit

This document audits every Electron `ipcMain.handle` / `ipcMain.on`
channel registered by the main process and pins the **input
validation** state for each. The goal is to make it a CI-visible
checklist: when a new IPC channel is added it must appear here with
its validation strategy, or this doc goes stale and CI surfaces the
drift.

> **Note:** Every channel marked `zod-schema` is validated by the
> schema named in parentheses in
> `apps/desktop/electron/ipc/schemas.ts`; every channel marked
> `scalar-helper` is validated by one of the typed `assert*` helpers
> exported from `apps/desktop/electron/ipc/validate.ts`
> (`assertString`, `assertOptionalString`, `assertUuid`, `assertId`,
> `assertProvider`, `assertSafePath`, `assertNumber`,
> `assertBoolean`, `assertStringArray`). The strategy table below
> tags each row with the primitive type expected so a reviewer can
> map the row back to the specific helper without grepping. New
> channels must ship with a corresponding row in this table; CI fails
> on drift.

The validation strategy for each channel is one of:

| Strategy           | What it means                                                                                                                                                                                                                                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **scalar-helper**  | Single primitive arg, validated by one of the typed `assert*` helpers from `ipc/validate.ts`: `assertString`, `assertOptionalString`, `assertUuid`, `assertId`, `assertProvider`, `assertSafePath`, `assertNumber`, `assertBoolean`, `assertStringArray`. The row's parenthetical (e.g. `scalar-helper (boolean)`) flags the specific type. |
| **zod-schema**     | Object arg validated by a `zod` schema in `ipc/schemas.ts`                                                                                                                                                                                                                                                                                  |
| **no-input**       | Handler takes no arguments — nothing to validate                                                                                                                                                                                                                                                                                            |
| **renderer-typed** | Arg is a renderer-supplied typed buffer / `unknown` cast that is shape-checked at the call site inside the handler (legacy pattern). Should migrate to `zod-schema`.                                                                                                                                                                        |

The "Auth" column flags channels whose payload touches authentication
state (OAuth tokens, API keys, password vault). These are the ones a
malicious renderer compromise would most want to abuse, so they get
extra scrutiny.

## Sources

| Channel                       | Strategy      | Auth |
| ----------------------------- | ------------- | ---- |
| `sources:addLocalFolder`      | scalar-helper |      |
| `sources:addLocalFile`        | scalar-helper |      |
| `sources:list`                | no-input      |      |
| `sources:remove`              | scalar-helper |      |
| `sources:search`              | scalar-helper |      |
| `sources:getDetail`           | scalar-helper |      |
| `sources:reindex`             | scalar-helper |      |
| `sources:getIndexingProgress` | scalar-helper |      |

The KChat-specific `sources:*` channels —
`sources:addKchatChannel` and `sources:backfillKchatChannel` —
are documented in the [KChat section](#kchat) below alongside the
rest of the 17-channel KChat surface, to keep the consolidated KChat
master list authoritative (it matches `EXPECTED_KCHAT_CHANNELS` in
`kchatIpc.test.ts`).

## Artifacts

| Channel                           | Strategy                         | Auth |
| --------------------------------- | -------------------------------- | ---- |
| `artifacts:create`                | scalar-helper                    |      |
| `artifacts:update`                | scalar-helper                    |      |
| `artifacts:list`                  | no-input                         |      |
| `artifacts:get`                   | scalar-helper                    |      |
| `artifacts:remove`                | scalar-helper                    |      |
| `artifacts:export`                | scalar-helper                    |      |
| `artifacts:exportToFile`          | scalar-helper                    |      |
| `artifacts:exportTypst`           | zod-schema (`TypstExportSchema`) |      |
| `artifacts:exportMarp`            | zod-schema (`MarpExportSchema`)  |      |
| `artifacts:listVersions`          | scalar-helper                    |      |
| `artifacts:restoreVersion`        | scalar-helper                    |      |
| `artifacts:generateFromTemplate`  | scalar-helper                    |      |
| `artifacts:extractTasksDecisions` | scalar-helper                    |      |
| `artifacts:compareSources`        | scalar-helper                    |      |
| `artifacts:exportEvidencePack`    | scalar-helper                    |      |

The four file-emitting channels — `artifacts:exportToFile`,
`artifacts:exportTypst`, `artifacts:exportMarp`,
`artifacts:exportEvidencePack` — gate every renderer-supplied
target path through `isSafeExportPath(target, getSafeExportRoots(),
getDenyExportRoots())`. The allow-list comes from
`app.getPath("downloads" | "documents" | "desktop" | "home" |
"userData")` plus `os.tmpdir()`; the deny-list carves out
`~/.tessera/kchat-channels/` so a compromised renderer cannot
overwrite the KChat channel cache and inject attacker-controlled
content that the connector would later ingest. Deny-list is
checked BEFORE the allow-list; symlinks and `..` traversal are
rejected through `path.resolve` normalisation.

## Templates

| Channel          | Strategy      | Auth |
| ---------------- | ------------- | ---- |
| `templates:list` | no-input      |      |
| `templates:get`  | scalar-helper |      |

## Citations

| Channel                    | Strategy                             | Auth |
| -------------------------- | ------------------------------------ | ---- |
| `citations:list`           | scalar-helper                        |      |
| `citations:add`            | zod-schema (`AddCitationSchema`)     |      |
| `citations:replace`        | zod-schema (`ReplaceCitationSchema`) |      |
| `citations:remove`         | scalar-helper                        |      |
| `citations:checkChanged`   | scalar-helper                        |      |
| `citations:checkFreshness` | scalar-helper                        |      |

## Settings & External Provider

| Channel                 | Strategy                                                                     | Auth                 |
| ----------------------- | ---------------------------------------------------------------------------- | -------------------- |
| `settings:get`          | no-input                                                                     |                      |
| `settings:update`       | zod-schema (`SettingsUpdateSchema`)                                          |                      |
| `externalProvider:get`  | no-input                                                                     | ✓ (returns redacted) |
| `externalProvider:set`  | zod-schema (`ExternalProviderConfigSchema` + `ExternalProviderApiKeySchema`) | ✓                    |
| `externalProvider:test` | no-input                                                                     | ✓ (uses cached key)  |

## Model & Runtime

| Channel                   | Strategy                             | Auth |
| ------------------------- | ------------------------------------ | ---- |
| `model:status`            | no-input                             |      |
| `model:start`             | scalar-helper                        |      |
| `model:stop`              | no-input                             |      |
| `model:generate`          | zod-schema (`GenerateRequestSchema`) |      |
| `model:cancelJob`         | no-input                             |      |
| `runtime:detectPlatform`  | no-input                             |      |
| `runtime:recommendModel`  | no-input                             |      |
| `runtime:listModels`      | no-input                             |      |
| `runtime:getCurrentModel` | no-input                             |      |
| `runtime:planDownload`    | scalar-helper                        |      |
| `runtime:downloadModel`   | scalar-helper                        |      |
| `runtime:deleteModel`     | no-input                             |      |

## Connectors

| Channel                         | Strategy                                               | Auth                                     |
| ------------------------------- | ------------------------------------------------------ | ---------------------------------------- |
| `connectors:authenticate`       | scalar-helper (provider) + renderer-typed `AuthConfig` | ✓ — stores OAuth tokens via `tokenVault` |
| `connectors:disconnect`         | scalar-helper                                          | ✓                                        |
| `connectors:status`             | scalar-helper                                          |                                          |
| `connectors:getRedirectUri`     | scalar-helper                                          |                                          |
| `connectors:getAllRedirectUris` | no-input                                               |                                          |
| `connectors:sync`               | scalar-helper                                          |                                          |
| `connectors:gdrive:listFiles`   | scalar-helper                                          |                                          |
| `connectors:gdrive:selectItems` | zod-schema (`GdriveSelectedItemsSchema`)               |                                          |
| `connectors:gdrive:sync`        | no-input                                               |                                          |

## Tasks

| Channel         | Strategy                        | Auth |
| --------------- | ------------------------------- | ---- |
| `tasks:list`    | no-input                        |      |
| `tasks:get`     | scalar-helper                   |      |
| `tasks:create`  | zod-schema (`CreateTaskSchema`) |      |
| `tasks:update`  | zod-schema (`UpdateTaskSchema`) |      |
| `tasks:delete`  | scalar-helper                   |      |
| `tasks:reorder` | scalar-helper                   |      |

## Automations

| Channel                       | Strategy                              | Auth |
| ----------------------------- | ------------------------------------- | ---- |
| `automations:list`            | no-input                              |      |
| `automations:get`             | scalar-helper                         |      |
| `automations:create`          | zod-schema (`CreateAutomationSchema`) |      |
| `automations:setEnabled`      | scalar-helper                         |      |
| `automations:delete`          | scalar-helper                         |      |
| `automations:schedulerStatus` | no-input                              |      |
| `automations:runNow`          | no-input                              |      |

## Dialog

| Channel                 | Strategy                               | Auth |
| ----------------------- | -------------------------------------- | ---- |
| `dialog:showSaveDialog` | zod-schema (`SaveDialogOptionsSchema`) |      |

## Slides

Presenter mode for the Slides editor. `slides:startPresentation`
receives a flattened, plain-text snapshot of the deck (per-slide
title, body lines, and speaker notes) plus the entry slide index, and
opens two windows from a single generated HTML file: a fullscreen
audience window and a presenter window (speaker notes + next-slide
preview). The two windows run on a dedicated session partition with
no preload bridge, so they cannot reach `window.tessera` or Node;
they stay in sync purely via `localStorage` `storage` events, so no
further IPC is needed once they are open. All deck strings are
rendered with `textContent` (never `innerHTML`) and the embedded deck
JSON is `<`/`>`/`&`-escaped, so deck content can never inject markup
into the presentation windows.

| Channel                    | Strategy                               | Auth |
| -------------------------- | -------------------------------------- | ---- |
| `slides:startPresentation` | zod-schema (`StartPresentationSchema`) |      |

## KChat

These channels expose the KChat (Mattermost v4) REST + WebSocket
integration to the renderer. Every channel runs through the shared
`KchatAuthService` singleton in `electron/appState.ts`
(`getKchatAuthService()`), which owns the `KchatClient` and the
encrypted token vault entry. The personal access token NEVER crosses
the IPC boundary — `kchat:connect` takes it as input but the handler
hands it directly to `KchatAuthService.connect` and only returns the
sanitised `KchatUserView`; `kchat:status` and every other read
returns connection state with no token field. The renderer hides
the entire KChat UI when `kchat:isAvailable` returns `false`.

| Channel                        | Strategy                                                 | Auth                                                                                                                                                                                                                                                                                                  |
| ------------------------------ | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kchat:isAvailable`            | no-input                                                 |                                                                                                                                                                                                                                                                                                       |
| `kchat:status`                 | no-input                                                 | ✓ — surfaces connection state (no token)                                                                                                                                                                                                                                                              |
| `kchat:connect`                | scalar-helper (token + URL)                              | ✓ — writes PAT to vault, verifies via `/users/me`                                                                                                                                                                                                                                                     |
| `kchat:disconnect`             | no-input                                                 | ✓ — clears vault entry, stops WebSocket                                                                                                                                                                                                                                                               |
| `kchat:listTeams`              | no-input                                                 |                                                                                                                                                                                                                                                                                                       |
| `kchat:listChannels`           | scalar-helper (KChat-id)                                 |                                                                                                                                                                                                                                                                                                       |
| `kchat:listMembers`            | scalar-helper (KChat-id)                                 |                                                                                                                                                                                                                                                                                                       |
| `kchat:listChannelFiles`       | scalar-helper (KChat-id + paging ints)                   |                                                                                                                                                                                                                                                                                                       |
| `kchat:shareArtifact`          | scalar-helper (artifact-id + KChat-id + format + bool×2) | ✓ — uploads bytes via KChat token                                                                                                                                                                                                                                                                     |
| `kchat:searchPosts`            | scalar-helper (query + limit)                            | ✓ — AEAD-verifies post bodies; rate-limited 10/s burst 20                                                                                                                                                                                                                                             |
| `kchat:fetchThreadContext`     | scalar-helper (source UUID + KChat post-id)              | ✓ — returns the thread root + up to 2 earlier replies (chronological); AEAD-verifies parent bodies; name enrichment reuses the shared LRU caches; rate-limited 5/s burst 10 (legitimate caller fires this once per expand-click)                                                                      |
| `kchat:openInDesktop`          | scalar-helper (KChat channel-id)                         | ✓ — constructs a `kchat://app/conversation/<id>` URL and invokes `shell.openExternal()`; shares a single rate-limiter bucket with `kchat:openDesktopExtensions` (key `kchat:openInDesktop`, 5/s burst 10) so a runaway renderer cannot multiply the OS-shell budget by opening N channels in parallel |
| `kchat:openDesktopExtensions`  | no-input                                                 | ✓ — constructs a `kchat://app/settings/extensions` URL and invokes `shell.openExternal()`; shares the rate-limiter bucket above                                                                                                                                                                       |
| `kchat:desktopBridgeStatus`    | no-input                                                 | ✓ — returns `{ detected: boolean, lastHeartbeatAt: number \| null }` based on the loopback API's last bearer-authed request timestamp (90 s freshness window); pure read of in-memory state; rate-limited 5/s burst 10 (Settings card polls at 10 s + sidebar polls at 10 s)                          |
| `kchat:backfillProgress`       | scalar-helper (KChat-id)                                 | ✓ — pure read of substrate state; rate-limited 2/s burst 5                                                                                                                                                                                                                                            |
| `sources:backfillKchatChannel` | scalar-helper (KChat-id)                                 | ✓ — historical-walk over `kchat:posts` REST surface                                                                                                                                                                                                                                                   |
| `sources:addKchatChannel`      | scalar-helper (KChat-id + display-name)                  | ✓ — uses the KChat token from the vault to fan-out channel-file downloads into the source vault                                                                                                                                                                                                       |

### Trust model for the KChat-Desktop integration surface

Three channels (`kchat:openInDesktop`,
`kchat:openDesktopExtensions`, `kchat:desktopBridgeStatus`) plus the
loopback HTTP API expose Tessera's `.kcz` extension integration with
KChat Desktop. The salient policies:

1. **Deeplink invocation is fire-and-forget**. `kchat:openInDesktop` /
   `kchat:openDesktopExtensions` only build a `kchat://...` URL and
   pass it to `shell.openExternal()` — they do not pass any token,
   secret, or PII along the URL. The OS protocol-handler dispatch
   decides whether KChat Desktop is reachable; the IPC handler
   resolves once the OS call returns.

2. **Loopback HTTP API trust boundary lives in the main process**.
   The bearer token (`crypto.randomBytes(32)` → base64url) and the
   bound-port number are written to `{userData}/tessera-kchat-port.json`
   at mode 0600 via atomic rename. The token is timing-safe-compared
   on every request via `requireBearer()`. Every request also asserts
   `Host: 127.0.0.1[:port]` to block DNS-rebind SSRF. The renderer
   never sees the token — only the `kchat:desktopBridgeStatus`
   read returns `{ detected, lastHeartbeatAt }`, derived from the
   loopback API's in-memory heartbeat counter.

3. **Transport is loopback-only**. `KchatLocalApiServer` binds to
   `127.0.0.1` exclusively (kernel-assigned port) — there is no
   `0.0.0.0` bind and no non-loopback interface bind. A remote
   attacker cannot reach the API even on a misconfigured host.

4. **Body cap, method allow-list, and route allow-list** all run
   before the handler dispatch. POST bodies are capped at 64 KiB
   and over-cap requests return HTTP 413 with `code: "payload_too_large"`.
   Unknown routes return 404 / `not_found`; wrong methods return
   405 / `method_not_allowed`.

5. **Rate-limited**. The two shell-launch channels share one
   rate-limiter bucket (`kchat:openInDesktop`, 5/s burst 10) so a
   runaway renderer that pings every channel in the sidebar can't
   multiply the OS-shell budget. The `kchat:desktopBridgeStatus`
   read is 5/s burst 10 (Settings card and sidebar both poll at 10 s).
   The loopback HTTP API itself rate-limits each route per remote
   address via the same `defaultRateLimiter` (loopback addresses
   only have one effective remote, so this is effectively per-extension).

6. **No session handoff between apps**. Tessera authenticates to the
   KChat server with its own PAT (held in the vault under provider
   `kchat`). KChat Desktop authenticates with its own session. The
   loopback API never proxies KChat-server credentials and never
   shares the PAT with the extension — the extension's identity
   for talking to the KChat server is its own, independent of
   Tessera's.

## Audit

Read-only renderer-facing view of the append-only `tessera_audit`
SQLite store. There is intentionally NO write channel — every audit
row is appended through the existing `bridgeLog*` pass-throughs
inside main-process IPC handlers, so the renderer cannot forge a
row. The reader clamps `limit` to `[1, 500]` so a renderer bug
cannot OOM the main process.

| Channel            | Strategy                                                | Auth |
| ------------------ | ------------------------------------------------------- | ---- |
| `audit:listRecent` | scalar-helper (`limit?`, `offset?` — both clamped ints) |      |

## Updates (auto-updater)

These channels are registered by
`apps/desktop/electron/autoUpdater.ts` (`registerAutoUpdaterIpc`). The
renderer subscribes to `updates:status` events emitted via
`webContents.send("updates:status", status)` for ambient toast UX —
see the [Renderer-bound emit channels](#renderer-bound-emit-channels-one-way-main--renderer)
section below for the push side of that channel. `updates:status` is
dual-purpose: the row in this table covers the `ipcMain.handle`
_pull_ endpoint (returning the cached last status), and the
corresponding entry in the emit-channels table covers the
`webContents.send` _push_ broadcast.

| Channel                        | Strategy                                                    | Auth |
| ------------------------------ | ----------------------------------------------------------- | ---- |
| `updates:status`               | no-input (pull only; also emitted as push — see emit table) |      |
| `updates:check`                | no-input                                                    |      |
| `updates:install`              | no-input                                                    |      |
| `updates:getAutoUpdateEnabled` | no-input                                                    |      |
| `updates:setAutoUpdateEnabled` | scalar-helper (boolean)                                     |      |

## Password Vault (ephemeral prompt window)

These channels are `ipcMain.on` (not `ipcMain.handle`) and are
**transient**: they are registered by `passwordVault.ts` only while
the password-prompt `BrowserWindow` is open at app startup, and torn
down via `ipcMain.removeListener(channel, handler)` as soon as the user
submits, cancels, or closes the window. The handler-targeted
`removeListener` is deliberate (not `removeAllListeners`): it removes
only the specific listener installed by the prompt's setup, so any
listener a future caller registers on the same channel name (e.g. a
test harness) is preserved. The prompt loads via
`data:text/html;charset=utf-8,…` (no `file://` or `http(s)://`), and
its preload (`passwordPromptPreload.ts`) only exposes a single
`tesseraPasswordPrompt` API that forwards the user input to these
two channels. The renderer for the _main_ app window cannot reach
these channels because they are not registered while the main window
is open.

| Channel                 | Strategy                                                                                                                                                                                                             | Auth                                                                                                                                                |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `password-vault:submit` | renderer-typed (`{ password: string }`, shape-checked at the call site; the password string is treated as opaque material — no length / charset assertions at the IPC boundary because the vault accepts any string) | ✓ — supplies the AES-256-GCM key-derivation input for the password vault                                                                            |
| `password-vault:cancel` | no-input                                                                                                                                                                                                             | ✓ — user-initiated abort; the in-flight `promptForVaultPassword` promise rejects and `maybeInitPasswordVault` falls through to "no password cached" |

**Invariant note (vault-specific).** The prompt's preload script is
the only renderer surface allowed to send on these two channels. The
preload is loaded via Electron's `webPreferences.preload` so it runs
in an isolated context; `sandbox: true` is set on the prompt
`BrowserWindow` so the preload cannot `require('electron')`
directly. Both properties are pinned by `sandboxPreloadContract.test.ts`
and `passwordVault.test.ts`.

## Renderer-bound emit channels (one-way, main → renderer)

These are `webContents.send(...)` channels rather than
`ipcMain.handle` channels, but they're documented here for
completeness:

| Channel                    | Producer                                                                            | Purpose                                                                                                                                                                                                                               |
| -------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model:token`              | `model:generate` SSE stream                                                         | Per-token streaming chunks                                                                                                                                                                                                            |
| `runtime:downloadProgress` | `runtime:downloadModel`                                                             | Download bytes-progress updates                                                                                                                                                                                                       |
| `updates:status`           | `autoUpdater.ts` `broadcast()` (driven by the underlying `electron-updater` events) | Auto-update lifecycle notifications (`checking`, `available`, `not-available`, `downloading`, `downloaded`, `error`) for the ambient toast UX. Also exposed as a pull endpoint — see [Updates (auto-updater)](#updates-auto-updater). |

## Invariants

The following invariants must hold for every channel in this doc:

1. **Untrusted-renderer assumption.** Any handler that accepts
   arguments must treat them as untrusted. A compromised renderer can
   send arbitrary values, including ones the TypeScript types claim
   are impossible. `scalar-helper` and `zod-schema` are both
   acceptable defenses; raw `string`/`number` casts are not.

2. **No path traversal.** Channels that accept paths (`sources:addLocalFolder`,
   `sources:addLocalFile`, `artifacts:exportToFile`,
   `dialog:showSaveDialog`) must validate that the path resolves
   inside an allowed root. `exportPathSafety.ts` enforces this for
   the export channels; folder-add channels rely on
   `dialog.showOpenDialog` (which returns OS-native paths) plus the
   bridge's own validation.

3. **No SQL injection.** All channels that flow into the bridge use
   typed napi structs; the Rust side uses parameterised queries via
   `rusqlite`. There is no string concatenation into SQL anywhere
   below the IPC layer.

4. **Secrets never round-trip the renderer.** `externalProvider:get`
   returns a redacted view (`hasApiKey: boolean` rather than the key
   itself). The real key is stored in `secretsVault` (encrypted) and
   loaded directly into the Rust runtime — the renderer cannot
   exfiltrate it via IPC.

5. **OAuth tokens are write-only from the renderer.** The renderer
   can call `connectors:authenticate` to _cause_ tokens to be stored
   (after going through the OAuth flow) but cannot read tokens back.
   `tokenVault` is only exposed to main-process modules.

6. **Encryption-at-rest.** All vault data is encrypted by
   `safeStorage` (OS keyring) or the password-vault fallback.
   Plaintext writes are not possible — both vault modules throw
   rather than degrade to unencrypted storage.

## Maintenance

When adding a new IPC channel:

1. Add the row to the appropriate table above.
2. Note the validation strategy.
3. If the channel touches auth state, mark `✓` in the Auth column
   and consider whether the invariants above need extension.
4. Update `ipc/schemas.ts` if you're introducing a new zod schema.
5. Add unit tests under `electron/__tests__/schemas.test.ts` for the
   schema's accept/reject behavior.
