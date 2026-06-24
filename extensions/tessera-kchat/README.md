# Tessera KChat Extension

A [KChat Desktop](https://github.com/uneycom/uney-chat-desktop) `.kcz`
extension that surfaces the KChat channels [Tessera](https://github.com/kennguy3n/Tessera)
has indexed, lets you trigger ingestion of the current channel without
leaving KChat Desktop, and routes "Share to Tessera"-style intents
through Tessera's localhost API.

## What this extension is — and is not

This extension is the **only** integration surface between Tessera and
KChat Desktop. It is **not** a session-handoff bridge: Tessera and
KChat Desktop both talk to the same KChat / Mattermost server, each
authenticating independently. The extension's role is purely UX
plumbing:

| Concern                                                 | Owner                                                               |
| ------------------------------------------------------- | ------------------------------------------------------------------- |
| Reading messages, channels, files from the KChat server | Both apps independently, via REST + PAT                             |
| Indexing channel content for evidence search            | Tessera (its own KChat REST connector)                              |
| Rendering the KChat conversation UI                     | KChat Desktop                                                       |
| Showing which channels Tessera has indexed              | **This extension** (rightbar view)                                  |
| Triggering ingestion of the current channel             | **This extension** → Tessera localhost API                          |
| Sharing a Tessera artifact back to a channel            | **This extension** → Tessera localhost API                          |
| Cross-app navigation                                    | `kchat://app/conversation/<id>` + `tessera://source/<id>` deeplinks |

There is **no** socket, no named pipe, and no shared session token
between Tessera and KChat Desktop. The two apps cooperate only
through (a) this `.kcz` extension and (b) the public deeplink
schemes.

## How the extension finds Tessera

When Tessera starts it binds a localhost HTTP server (random port,
loopback only) and writes
`{userData}/tessera-kchat-port.json`. Both apps' user-data
directories live under the same platform default
(`~/Library/Application Support/Tessera`, `~/.config/Tessera`,
`%APPDATA%/Tessera`) so KChat Desktop's extension sandbox can read
that file when its filesystem capability is granted.

The discovery file carries the port number and a bearer token. The
extension reads it on activation, then talks to
`http://127.0.0.1:<port>/api/*` with `Authorization: Bearer <token>`.
If the file is missing or unreadable, the rightbar view shows a
"Tessera is not running" state with a Retry button — there is no
busy-loop, no probe socket, no fall-back protocol.

## Building

```bash
cd extensions/tessera-kchat
npm install
npm run build
```

The build:

1. Runs `tsc` against `tsconfig.json`, populating `dist/`.
2. Runs `scripts/build.mjs`, which packages
   `manifest.json + dist/ + README.md` into
   `releases/com.tessera.kchat-bridge@<version>.kcz` and writes a
   sibling `.sha256` file.

The zip is deterministic — two builds of the same source produce a
byte-equal `.kcz`. This matters for release signing later.

You can also run `npm run build:kchat-extension` from the Tessera repo
root.

## Installing the `.kcz` into KChat Desktop

1. Open KChat Desktop.
2. Navigate to **Settings → Developer → Extensions**.
3. Click **"Install from .kcz"** and pick
   `releases/com.tessera.kchat-bridge@<version>.kcz`.
4. KChat Desktop verifies the manifest, prompts you to grant the
   three requested KChat procedures (`kchat.query_messages`,
   `kchat.query_conversations`, `kchat.send_message`), and mounts the
   "Tessera Sources" view in the rightbar.

The extension performs no network I/O until you open the rightbar
view. Once open, it polls Tessera's `/api/status` and `/api/sources`
on the lightest possible cadence.

## Permissions requested

| Procedure                   | Category | Why                                                                                                                                                                                   |
| --------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kchat.query_messages`      | read     | Allow the rightbar view to display the names of indexed channels and check whether the current channel has been ingested.                                                             |
| `kchat.query_conversations` | read     | Render the list of channels the host has loaded so the user knows which ones Tessera can see.                                                                                         |
| `kchat.send_message`        | write    | Post the artifact-share card back into the conversation the user selected. The post is composed by Tessera (link + optional evidence-pack reference); the extension only forwards it. |

The user is asked to grant each procedure individually at install
time. Declining `kchat.send_message` still leaves the read-side
features (browse indexed sources, ingest the current channel) fully
operational.

## Source layout

```
extensions/tessera-kchat/
├── manifest.json              — extension manifest
├── package.json               — build scripts
├── tsconfig.json              — TypeScript config
├── scripts/
│   ├── build.mjs              — .kcz packager
│   ├── build.test.mjs         — unit tests for the packager
│   ├── fsWalk.mjs             — deterministic directory walker
│   └── zipWriter.mjs          — minimal zip writer
├── src/
│   ├── index.ts               — extension entry (activate / deactivate)
│   ├── types.ts               — wire types shared with Tessera localhost API
│   ├── client.ts              — typed HTTP client for the localhost API
│   ├── portFile.ts            — port-file discovery + validation
│   └── views/
│       └── sources-panel.tsx  — rightbar React view
├── dist/                      — generated by `tsc`
└── releases/                  — generated by `scripts/build.mjs`
```

## React is host-provided (do not bundle)

This extension declares `react` and `react-dom` as **peer
dependencies** (see `package.json`), never as runtime dependencies.
The KChat Desktop extension host injects its own React instance at
activation time — every `.kcz` extension running inside KChat Desktop
must share the host's React so contributed views (the `tessera.sources-panel`
rightbar view we declare in `manifest.json`) don't trip the
[two-React-instances hooks bug](https://react.dev/warnings/invalid-hook-call-warning#duplicate-react).

What this means in practice:

- `src/views/sources-panel.tsx` compiles with `"jsx": "react-jsx"`
  (see `tsconfig.json`), which generates `import { jsx } from
"react/jsx-runtime"` calls at the bottom of the compiled JS. These
  imports are resolved at extension-activation time by the host's
  module resolver, not at build time.
- `scripts/build.mjs` does not bundle dependencies — it ships the
  raw `tsc` output. Any `import "react"` in the source survives into
  the `.kcz`, and the host fulfils it from its own React instance.
- If a future contributor migrates `react` into `dependencies`, the
  build will inline a duplicate React into the `.kcz`. That is a
  silent regression — the extension would appear to work, but every
  view contributed to a host slot would create a second React tree
  and any hook call inside it would throw "Invalid hook call".
  Keeping React in `peerDependencies` is the structural fix.

If KChat Desktop ever changes the host-injection contract, the
extension installer will surface the resolution failure at
activation with a clear error envelope rather than failing at
runtime — so the contract is fail-loud, not fail-silent.

## License

MIT, same as the parent Tessera repo.
