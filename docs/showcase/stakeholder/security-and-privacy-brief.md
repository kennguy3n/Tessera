# Tessera — Security & Privacy Brief

_For security reviewers, IT, compliance, and privacy officers evaluating Tessera._

## Summary

Tessera is a local-first desktop application. By default, your content is indexed and
processed on your own machine, and AI generation runs against a local model. Data does not
leave the device unless you take an explicit, visible action (connecting a cloud source or
exporting a file). This brief explains the architecture and controls behind that claim.

## Data flow

```
Local folders / files ──▶ Local index (on device)
                                  │
        Explicitly connected      ▼
        cloud sources ────▶ Source selection (you choose, per artifact)
                                  │
                                  ▼
                        Local model generation
                                  │
                                  ▼
              Editable artifact + inline source citations
                                  │
                                  ▼
                    Export (only on explicit user action)
```

- **Indexing is local.** Pointing Tessera at a folder indexes its contents on the device.
- **Inference is local.** The recommended model runs on the machine; generation does not call
  out to a third-party inference API.
- **Sources are opt-in and per-artifact.** Generation only sees the sources you select for
  that artifact. Cloud connectors (Google Drive, OneDrive/SharePoint, Notion, Jira,
  Confluence, Figma) are explicitly connected and show a clear connected/disconnected state.
- **Egress is explicit.** Data leaves the device only when you connect an external source or
  export an artifact — both deliberate, visible actions.

## Why this matters for regulated work

The personas in this showcase are not incidental — they're the workloads that _can't_ use a
cloud AI assistant:

- **Healthcare (PHI):** a HIPAA breach assessment is built from the most sensitive data in
  the building. Local-first means the PHI never traverses a vendor's servers.
- **Legal (privilege):** privileged contracts and matter material stay on the device,
  preserving confidentiality.
- **Finance (NPI):** borrower financials and credit decisions remain inside the bank's
  control.

In each case, "the model runs locally" is the difference between "approved tool" and "policy
violation."

## Security controls

Tessera's security posture (see the repo `README.md` and `CHANGELOG.md`) includes:

- **App-lock with FIDO2/WebAuthn** — hardware-backed authentication to open the workspace.
- **Secure deletion** — `PRAGMA secure_delete` on all database deletion paths so removed
  content is actually overwritten.
- **Tightened Content Security Policy** — constrains what the renderer can load and execute.
- **Keychain enforce-mode** — write-blocking when OS keychain protection is unavailable.
- **Supply-chain CI gates** — `cargo vet` for Rust dependencies and `npm audit` for the
  JavaScript side, enforced in CI.
- **Crash isolation** — React error boundaries with crash reporting so a single component
  failure can't silently corrupt the workspace.

## Provenance & auditability

Every generated section carries inline citations to the source files it drew from (e.g.
`[02-endpoint-mdm-report.md]`). This gives reviewers a direct audit trail from any claim in an
artifact back to the source material — essential for compliance documents, legal abstracts,
and credit memos where "where did this come from?" must always be answerable.

## What to verify in your own review

1. **Network behavior:** observe that, with no cloud sources connected, generation produces
   no outbound inference traffic.
2. **Source scoping:** confirm an artifact only reflects the sources selected for it.
3. **Export gating:** confirm artifacts leave the device only via explicit export.
4. **Deletion:** confirm deleted artifacts are removed via the secure-delete path.

## Open source

Tessera is MIT-licensed and auditable. Security claims in this brief can be verified against
the source. We encourage reviewers to inspect the indexing, source-selection, and generation
paths directly rather than taking this document on faith.
