# IPC Audit (WS10)

This document audits every Electron `ipcMain.handle` / `ipcMain.on`
channel registered by the main process and pins the **input
validation** state for each. The goal is to make it a CI-visible
checklist: when a new IPC channel is added it must appear here with
its validation strategy, or this doc goes stale and CI surfaces the
drift.

> **Note:** This doc describes the post-WS6 + post-WS10 shipping state.
> WS6 introduces the per-domain split of `ipc.ts` and the `zod`
> schemas referenced below. Until WS6 lands on `main`, the channels
> marked `zod-schema` are still validated by the legacy
> `renderer-typed` pattern documented inline at their call sites.
> Treat the audit table as the design contract; the WS6 PR is what
> makes the runtime conform to it.

The validation strategy for each channel is one of:

| Strategy        | What it means                                                                                                                          |
|-----------------|----------------------------------------------------------------------------------------------------------------------------------------|
| **scalar-helper** | Single primitive arg, validated by `assertId` / `assertString` / `assertNumber` / `assertStringArray` from `ipc/validate.ts`         |
| **zod-schema**    | Object arg validated by a `zod` schema in `ipc/schemas.ts` (introduced in WS6)                                                       |
| **no-input**      | Handler takes no arguments — nothing to validate                                                                                     |
| **renderer-typed**| Arg is a renderer-supplied typed buffer / `unknown` cast that is shape-checked at the call site inside the handler (legacy pattern). Should migrate to `zod-schema`. |

The "Auth" column flags channels whose payload touches authentication
state (OAuth tokens, API keys, password vault). These are the ones a
malicious renderer compromise would most want to abuse, so they get
extra scrutiny.

## Sources

| Channel                               | Strategy        | Auth |
|---------------------------------------|-----------------|------|
| `sources:addLocalFolder`              | scalar-helper   |      |
| `sources:addLocalFile`                | scalar-helper   |      |
| `sources:list`                        | no-input        |      |
| `sources:remove`                      | scalar-helper   |      |
| `sources:search`                      | scalar-helper   |      |
| `sources:getDetail`                   | scalar-helper   |      |
| `sources:reindex`                     | scalar-helper   |      |
| `sources:getIndexingProgress`         | scalar-helper   |      |

## Artifacts

| Channel                               | Strategy        | Auth |
|---------------------------------------|-----------------|------|
| `artifacts:create`                    | scalar-helper   |      |
| `artifacts:update`                    | scalar-helper   |      |
| `artifacts:list`                      | no-input        |      |
| `artifacts:get`                       | scalar-helper   |      |
| `artifacts:remove`                    | scalar-helper   |      |
| `artifacts:export`                    | scalar-helper   |      |
| `artifacts:exportToFile`              | scalar-helper   |      |
| `artifacts:exportTypst`               | zod-schema (`TypstExportSchema`)   |  |
| `artifacts:exportMarp`                | zod-schema (`MarpExportSchema`)    |  |
| `artifacts:listVersions`              | scalar-helper   |      |
| `artifacts:restoreVersion`            | scalar-helper   |      |
| `artifacts:generateFromTemplate`      | scalar-helper   |      |
| `artifacts:extractTasksDecisions`     | scalar-helper   |      |
| `artifacts:compareSources`            | scalar-helper   |      |
| `artifacts:exportEvidencePack`        | scalar-helper   |      |

## Templates

| Channel                               | Strategy        | Auth |
|---------------------------------------|-----------------|------|
| `templates:list`                      | no-input        |      |
| `templates:get`                       | scalar-helper   |      |

## Citations

| Channel                               | Strategy        | Auth |
|---------------------------------------|-----------------|------|
| `citations:list`                      | scalar-helper   |      |
| `citations:add`                       | zod-schema (`AddCitationSchema`)         |  |
| `citations:replace`                   | zod-schema (`ReplaceCitationSchema`)     |  |
| `citations:remove`                    | scalar-helper   |      |
| `citations:checkChanged`              | scalar-helper   |      |
| `citations:checkFreshness`            | scalar-helper   |      |

## Settings & External Provider

| Channel                               | Strategy        | Auth |
|---------------------------------------|-----------------|------|
| `settings:get`                        | no-input        |      |
| `settings:update`                     | zod-schema (`SettingsUpdateSchema`)       |  |
| `externalProvider:get`                | no-input        | ✓ (returns redacted) |
| `externalProvider:set`                | zod-schema (`ExternalProviderConfigSchema` + `ExternalProviderApiKeySchema`) | ✓ |
| `externalProvider:test`               | no-input        | ✓ (uses cached key) |

## Model & Runtime

| Channel                               | Strategy        | Auth |
|---------------------------------------|-----------------|------|
| `model:status`                        | no-input        |      |
| `model:start`                         | scalar-helper   |      |
| `model:stop`                          | no-input        |      |
| `model:generate`                      | zod-schema (`GenerateRequestSchema`) |  |
| `model:cancelJob`                     | no-input        |      |
| `runtime:detectPlatform`              | no-input        |      |
| `runtime:recommendModel`              | no-input        |      |
| `runtime:listModels`                  | no-input        |      |
| `runtime:getCurrentModel`             | no-input        |      |
| `runtime:planDownload`                | scalar-helper   |      |
| `runtime:downloadModel`               | scalar-helper   |      |
| `runtime:deleteModel`                 | no-input        |      |

## Connectors

| Channel                               | Strategy                                                  | Auth |
|---------------------------------------|-----------------------------------------------------------|------|
| `connectors:authenticate`             | scalar-helper (provider) + renderer-typed `AuthConfig`    | ✓ — stores OAuth tokens via `tokenVault` |
| `connectors:disconnect`               | scalar-helper                                             | ✓    |
| `connectors:status`                   | scalar-helper                                             |      |
| `connectors:getRedirectUri`           | scalar-helper                                             |      |
| `connectors:getAllRedirectUris`       | no-input                                                  |      |
| `connectors:sync`                     | scalar-helper                                             |      |
| `connectors:gdrive:listFiles`         | scalar-helper                                             |      |
| `connectors:gdrive:selectItems`       | zod-schema (`GdriveSelectedItemsSchema`)                  |      |
| `connectors:gdrive:sync`              | no-input                                                  |      |

## Tasks

| Channel                               | Strategy        | Auth |
|---------------------------------------|-----------------|------|
| `tasks:list`                          | no-input        |      |
| `tasks:get`                           | scalar-helper   |      |
| `tasks:create`                        | zod-schema (`CreateTaskSchema`)   |  |
| `tasks:update`                        | zod-schema (`UpdateTaskSchema`)   |  |
| `tasks:delete`                        | scalar-helper   |      |
| `tasks:reorder`                       | scalar-helper   |      |

## Automations

| Channel                               | Strategy        | Auth |
|---------------------------------------|-----------------|------|
| `automations:list`                    | no-input        |      |
| `automations:get`                     | scalar-helper   |      |
| `automations:create`                  | zod-schema (`CreateAutomationSchema`) |  |
| `automations:setEnabled`              | scalar-helper   |      |
| `automations:delete`                  | scalar-helper   |      |
| `automations:schedulerStatus`         | no-input        |      |
| `automations:runNow`                  | no-input        |      |

## Dialog

| Channel                               | Strategy                                  | Auth |
|---------------------------------------|-------------------------------------------|------|
| `dialog:showSaveDialog`               | zod-schema (`SaveDialogOptionsSchema`)    |      |

## Updates (auto-updater)

| Channel                               | Strategy        | Auth |
|---------------------------------------|-----------------|------|
| `updates:status`                      | no-input        |      |
| `updates:check`                       | no-input        |      |
| `updates:install`                     | no-input        |      |
| `updates:getAutoUpdateEnabled`        | no-input        |      |

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
two channels. The renderer for the *main* app window cannot reach
these channels because they are not registered while the main window
is open.

| Channel                               | Strategy        | Auth |
|---------------------------------------|-----------------|------|
| `password-vault:submit`               | renderer-typed (`{ password: string }`, shape-checked at the call site; the password string is treated as opaque material — no length / charset assertions at the IPC boundary because the vault accepts any string) | ✓ — supplies the AES-256-GCM key-derivation input for the password vault |
| `password-vault:cancel`               | no-input        | ✓ — user-initiated abort; the in-flight `promptForVaultPassword` promise rejects and `maybeInitPasswordVault` falls through to "no password cached" |

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

| Channel                       | Producer                       | Purpose                                 |
|-------------------------------|--------------------------------|-----------------------------------------|
| `model:token`                 | `model:generate` SSE stream    | Per-token streaming chunks              |
| `runtime:downloadProgress`    | `runtime:downloadModel`        | Download bytes-progress updates         |

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
   can call `connectors:authenticate` to *cause* tokens to be stored
   (after going through the OAuth flow) but cannot read tokens back.
   `tokenVault` is only exposed to main-process modules.

6. **Encryption-at-rest.** All vault data is encrypted by
   `safeStorage` (OS keyring) or the WS10 password-vault fallback.
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
