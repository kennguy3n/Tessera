# Architecture Decision Records

This directory captures the significant architectural decisions behind
Tessera using lightweight [Architecture Decision Records](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions)
(ADRs). Each record is immutable once accepted: rather than editing an
old decision, supersede it with a new ADR and update the `Status` line.

Every ADR follows the same structure — **Title**, **Status**,
**Context**, **Decision**, **Consequences** — and is grounded in how the
decision actually manifests in this codebase (file paths are given so
the record stays verifiable).

| ADR                                                    | Decision                                                       |
| ------------------------------------------------------ | -------------------------------------------------------------- |
| [0001](0001-rust-core.md)                              | Rust for the core engine                                       |
| [0002](0002-electron.md)                               | Electron + React for the desktop shell                         |
| [0003](0003-sqlcipher.md)                              | SQLCipher for encryption at rest                               |
| [0004](0004-local-first.md)                            | Local-first architecture                                       |
| [0005](0005-kchat-collaboration.md)                    | KChat (Mattermost v4) as the collaboration layer               |
| [0006](0006-ternary-bonsai.md)                         | Ternary-Bonsai as the default local model                      |
| [0007](0007-ivf-flat.md)                               | IVF-Flat ANN index for vector search                           |
| [0008](0008-n-api-bridge.md)                           | N-API bridge between Electron and Rust                         |
| [0009](0009-single-file-db.md)                         | Single shared SQLite connection / single-file DB               |
| [0010](0010-csp-nonce.md)                              | Per-session CSP nonce for the renderer                         |
| [0011](0011-knowledge-substrate-integration.md)        | Integrate the knowledge substrate as an additive native layer  |
| [0012](0012-deliberate-skills-engine.md)               | Deliberate multi-step Skills engine for small-model AI quality |
| [0013](0013-user-authored-skills.md)                   | User-authored ("custom") Skills persisted in the renderer      |
| [0014](0014-deterministic-step-checks-and-repair.md)   | Deterministic per-step output checks with bounded auto-repair  |
| [0015](0015-custom-skill-check-authoring.md)           | Acceptance-check authoring in the custom-skill editor          |
| [0016](0016-custom-skill-sampling-authoring.md)        | Per-step sampling authoring in the custom-skill editor         |
| [0017](0017-custom-skill-output-contract-authoring.md) | Per-step output-contract authoring in the custom-skill editor  |
| [0018](0018-skill-export-import.md)                    | Export / import a skill as a portable, shareable file          |
| [0019](0019-slide-brand-kit.md)                        | Slide Brand Kit data model + brand-aware theming               |
| [0020](0020-slide-template-library.md)                 | Slide template library: breadth, taxonomy, and gallery         |
| [0021](0021-slide-visual-polish.md)                    | Slide visual polish — smart layouts, icons, aspect ratios      |
| [0022](0022-slide-brand-pack.md)                       | Slide Brand Pack — portable export / import of a brand kit     |
| [0023](0023-slide-user-templates.md)                   | User-authored slide templates + portable template files        |
| [0024](0024-slide-branded-export.md)                   | Branded export fidelity — brand survives PPTX / PDF / HTML     |
| [0025](0025-slide-pptx-brand-import.md)                | Slide brand import — extract a Brand Kit from a .pptx           |
| [0026](0026-document-template-library.md)              | Document template library — in-editor gallery + portable files |
| [0027](0027-sheet-template-library.md)                 | Sheet template library, toolbar discoverability, locale formats |
| [0028](0028-base-app-mode.md)                          | Base app-usage mode + Base template gallery                    |
